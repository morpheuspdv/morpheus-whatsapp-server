/**
 * Morpheus WhatsApp Server
 * Servidor HTTP baseado em Baileys (ESM-compatible via dynamic import)
 * Compatível com Evolution API — usado pelo sistema Morpheus PDV
 *
 * Endpoints:
 *   GET  /health                          → healthcheck (sem auth)
 *   GET  /status                          → estado da conexão
 *   GET  /qr                              → QR Code em base64
 *   POST /send                            → enviar { phone, message }
 *   POST /logout                          → desconectar sessão
 *   POST /reconnect                       → reconectar sem logout
 *   GET  /instance/fetchInstances         → listar instâncias (Evolution API)
 *   GET  /instance/connectionState/:inst  → estado (Evolution API)
 *   GET  /instance/connect/:inst          → conectar / buscar QR (Evolution API)
 *   POST /instance/create                 → criar instância (no-op)
 *   DELETE /instance/logout/:inst         → logout (Evolution API)
 *   POST /message/sendText/:inst          → enviar texto (Evolution API)
 */

require('dotenv').config();

const express = require('express');
const QRCode  = require('qrcode');
const pino    = require('pino');
const path    = require('path');
const fs      = require('fs');

// ── Configurações ─────────────────────────────────────────────
const PORT          = process.env.PORT          || 65002;
const API_KEY       = process.env.API_KEY       || 'morpheus-wpp-2026';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'morpheus-pdv';
const AUTH_DIR      = path.join(__dirname, 'auth_session');

const app = express();
app.use(express.json());

// ── Estado global ─────────────────────────────────────────────
const state = {
    sock:        null,
    connected:   false,
    qrBase64:    null,
    qrRaw:       null,
    qrUpdatedAt: 0,
    status:      'disconnected',   // disconnected | qr_ready | connected | logged_out
    phoneNumber: null,
};

// ── Middleware de autenticação ─────────────────────────────────
function auth(req, res, next) {
    const key = req.headers['apikey'] || req.headers['api-key'] || req.query.apikey;
    if (key !== API_KEY) return res.status(401).json({ error: 'Chave de API inválida.' });
    next();
}

// ── Utilitário de delay (não depende do Baileys) ───────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Controle de reconexão ─────────────────────────────────────
let _reconnectCount = 0;
let _starting       = false;

// ── Iniciar WhatsApp com dynamic import (suporte ESM) ─────────
async function startWhatsApp() {
    if (_starting) return;
    _starting = true;

    // Garante diretório de sessão
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    // ── Dynamic import do Baileys (ESM) ───────────────────────
    const {
        default: makeWASocket,
        useMultiFileAuthState,
        DisconnectReason,
        fetchLatestBaileysVersion,
        delay,
    } = await import('@whiskeysockets/baileys');

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Versão do protocolo WhatsApp — fallback se offline
    let version = [2, 3000, 1015901307];
    try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
    } catch (_) {
        console.log('[WPP] Usando versão fallback:', version.join('.'));
    }

    console.log(`[WPP] Iniciando Baileys v${version.join('.')}...`);

    const sock = makeWASocket({
        version,
        auth:                authState,
        logger:              pino({ level: 'silent' }),
        printQRInTerminal:   true,
        browser:             ['Morpheus PDV', 'Chrome', '120.0'],
        connectTimeoutMs:    30_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2_000,
        syncFullHistory:     false,
        markOnlineOnConnect: false,
        getMessage:          async () => undefined,
    });

    state.sock = sock;

    // ── Eventos de conexão ────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            state.status      = 'qr_ready';
            state.connected   = false;
            state.qrRaw       = qr;
            state.qrUpdatedAt = Date.now();
            state.qrBase64    = await QRCode.toDataURL(qr, {
                width: 300, margin: 2,
                color: { dark: '#000000', light: '#FFFFFF' },
            });
            console.log('[WPP] QR Code pronto — escaneie no celular');
        }

        if (connection === 'open') {
            state.connected   = true;
            state.status      = 'connected';
            state.qrBase64    = null;
            state.qrRaw       = null;
            state.phoneNumber = sock.user?.id?.split(':')[0] ?? null;
            _reconnectCount   = 0;
            _starting         = false;
            console.log(`[WPP] Conectado! Número: ${state.phoneNumber}`);
        }

        if (connection === 'close') {
            state.connected = false;
            state.status    = 'disconnected';
            state.qrBase64  = null;
            state.qrRaw     = null;
            _starting       = false;
            const code      = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            console.log(`[WPP] Desconectado (código ${code}). Reconectar: ${shouldReconnect}`);

            // Limpa socket antigo antes de reconectar (evita memory leak)
            const oldSock = state.sock;
            state.sock = null;
            try { oldSock?.ev?.removeAllListeners?.(); } catch (_) {}

            if (shouldReconnect) {
                _reconnectCount++;
                const waitMs = Math.min(3000 * _reconnectCount, 30000);
                console.log(`[WPP] Aguardando ${waitMs}ms (tentativa ${_reconnectCount})...`);
                await delay(waitMs);
                startWhatsApp();
            } else {
                console.log('[WPP] Logout detectado — limpando sessão...');
                state.status = 'logged_out';
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);
    return sock;
}

// ── Formatar número ────────────────────────────────────────────
function formatPhone(phone) {
    let n = phone.replace(/\D/g, '');
    if (!n.startsWith('55') && n.length <= 11) n = '55' + n;
    // 9º dígito: celulares BR = 55 + DDD(2) + 9 + 8 dígitos = 13 no total
    // Se chegou com 12 (sem o 9), insere o 9 após o DDD
    if (n.startsWith('55') && n.length === 12) n = n.slice(0, 4) + '9' + n.slice(4);
    return n + '@s.whatsapp.net';
}

// ══════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════

// Health check (sem autenticação)
app.get('/health', (req, res) => {
    res.json({ ok: true, status: state.status, uptime: process.uptime() });
});

// Status da conexão
app.get('/status', auth, (req, res) => {
    res.json({
        status:    state.status,
        connected: state.connected,
        phone:     state.phoneNumber,
        qr_ready:  !!state.qrBase64,
        qr_age_ms: state.qrUpdatedAt ? Date.now() - state.qrUpdatedAt : null,
    });
});

// ── Evolution API compatibility ────────────────────────────────

app.get('/instance/fetchInstances', auth, (req, res) => {
    res.json([{
        instanceName: INSTANCE_NAME,
        instance: { instanceName: INSTANCE_NAME, status: state.status },
    }]);
});

app.get('/instance/connectionState/:instance', auth, (req, res) => {
    const evState = state.connected ? 'open'
        : state.status === 'qr_ready' ? 'connecting'
        : 'close';
    res.json({ instance: { instanceName: req.params.instance, state: evState } });
});

// Conectar / buscar QR Code — inicia Baileys sob demanda
app.get('/instance/connect/:instance', auth, async (req, res) => {
    if (state.connected) {
        return res.json({ instance: { instanceName: req.params.instance, state: 'open' } });
    }
    // Dispara Baileys se ainda não estiver rodando
    if (!state.sock && !_starting) {
        startWhatsApp().catch(err => {
            console.error('[WPP] Erro ao iniciar:', err.message);
            _starting = false;
        });
    }
    // Resposta imediata — sem bloqueio (PHP tem timeout curto)
    if (state.qrBase64) {
        return res.json({ base64: state.qrBase64, qrcode: { base64: state.qrBase64 } });
    }
    // 202 = ainda iniciando, JS vai tentar novamente
    return res.status(202).json({ status: state.status, message: 'Iniciando WhatsApp...' });
});

app.post('/instance/create', auth, (req, res) => {
    res.json({ instance: { instanceName: INSTANCE_NAME, status: 'created' } });
});

app.delete('/instance/logout/:instance', auth, async (req, res) => {
    try {
        if (state.sock) await state.sock.logout();
        state.connected = false;
        state.status    = 'logged_out';
        state.qrBase64  = null;
        state.sock      = null;
        _starting       = false;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/message/sendText/:instance', auth, async (req, res) => {
    const { number, text } = req.body;
    if (!number || !text) return res.status(400).json({ error: 'Campos obrigatórios: number, text' });
    if (!state.connected || !state.sock) return res.status(503).json({ error: 'WhatsApp não conectado.' });
    try {
        let n = number.replace(/\D/g, '');
        if (!n.startsWith('55') && n.length <= 11) n = '55' + n;
        if (n.startsWith('55') && n.length === 12) n = n.slice(0, 4) + '9' + n.slice(4);
        const jid = n + '@s.whatsapp.net';
        console.log(`[WPP] sendText → número recebido: "${number}" | JID: ${jid} | texto: ${text.slice(0, 50)}`);
        const result = await state.sock.sendMessage(jid, { text });
        console.log(`[WPP] sendText OK → msgId: ${result?.key?.id} | remoteJid: ${result?.key?.remoteJid}`);
        res.json({ key: { id: result?.key?.id || Date.now().toString() }, status: 'PENDING' });
    } catch (err) {
        console.error(`[WPP] sendText ERRO → ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// QR Code em base64
app.get('/qr', auth, async (req, res) => {
    if (state.connected) return res.json({ error: 'Já conectado.' });
    // Dispara Baileys se necessário
    if (!state.sock && !_starting) {
        startWhatsApp().catch(err => { _starting = false; });
    }
    if (!state.qrBase64) {
        return res.status(202).json({
            error: 'QR ainda não disponível. Aguarde e tente novamente.',
            status: state.status,
        });
    }
    res.json({
        base64:     state.qrBase64,
        updated_at: state.qrUpdatedAt,
        age_ms:     Date.now() - state.qrUpdatedAt,
        expires_in: Math.max(0, 60 - Math.floor((Date.now() - state.qrUpdatedAt) / 1000)),
    });
});

// Enviar mensagem
app.post('/send', auth, async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Campos obrigatórios: phone, message' });
    if (!state.connected || !state.sock) return res.status(503).json({ error: 'WhatsApp não conectado.' });
    try {
        const jid = formatPhone(phone);
        console.log(`[WPP] /send → phone: "${phone}" | JID: ${jid}`);
        await state.sock.sendMessage(jid, { text: message });
        res.json({ success: true, phone: jid.replace('@s.whatsapp.net', '') });
    } catch (err) {
        console.error('[WPP] Erro ao enviar:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Logout
app.post('/logout', auth, async (req, res) => {
    try {
        if (state.sock) await state.sock.logout();
        state.connected = false;
        state.status    = 'logged_out';
        state.qrBase64  = null;
        state.sock      = null;
        _starting       = false;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        res.json({ success: true, message: 'Desconectado com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reconectar sem logout
app.post('/reconnect', auth, async (req, res) => {
    try {
        if (state.sock) { state.sock.end(); state.sock = null; }
        _starting = false;
        await sleep(1500);
        startWhatsApp().catch(err => { _starting = false; });
        res.json({ success: true, message: 'Reconectando...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Inicia servidor HTTP ───────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   Morpheus WhatsApp Server               ║`);
    console.log(`║   Porta: ${String(PORT).padEnd(34)}║`);
    console.log(`║   Instância: ${INSTANCE_NAME.padEnd(29)}║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    // Inicia Baileys imediatamente para que o QR esteja pronto quando solicitado
    startWhatsApp().catch(err => {
        console.error('[WPP] Erro no boot:', err.message);
        _starting = false;
    });
});

// Captura erros não tratados para evitar crash
process.on('uncaughtException',  (err) => console.error('[ERRO]', err.message));
process.on('unhandledRejection', (err) => console.error('[REJECT]', err?.message || err));
