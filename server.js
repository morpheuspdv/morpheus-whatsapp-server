/**
 * Morpheus WhatsApp Server
 * Servidor HTTP próprio baseado em Baileys (open source)
 * Expõe a mesma API da Evolution API — compatível com o sistema Morpheus
 *
 * Endpoints:
 *   GET  /status           → estado da conexão
 *   GET  /qr               → QR Code em base64 (para exibir no sistema)
 *   POST /send             → enviar mensagem { phone, message }
 *   POST /logout           → desconectar sessão
 *   GET  /health           → healthcheck
 *
 * Autenticação: header  apikey: SUA_CHAVE
 */

require('dotenv').config();

const express  = require('express');
const QRCode   = require('qrcode');
const pino     = require('pino');
const path     = require('path');
const fs       = require('fs');

// ── Importa Baileys ───────────────────────────────────────────
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    delay,
} = require('@whiskeysockets/baileys');

// ── Configurações ─────────────────────────────────────────────
const PORT      = process.env.PORT      || 65002;  // Railway define PORT automaticamente
const API_KEY   = process.env.API_KEY   || 'morpheus-wpp-2026';
const AUTH_DIR  = path.join(__dirname, 'auth_session');
const LOG_LEVEL = process.env.LOG_LEVEL || 'silent'; // silent em produção

const logger = pino({ level: LOG_LEVEL });
const app    = express();
app.use(express.json());

// ── Estado global ─────────────────────────────────────────────
const state = {
    sock:        null,
    connected:   false,
    qrBase64:    null,       // QR atual em base64
    qrRaw:       null,       // string crua do QR
    qrUpdatedAt: 0,
    status:      'disconnected',  // disconnected | qr_ready | connected
    phoneNumber: null,
};

// ── Middleware de autenticação ─────────────────────────────────
function auth(req, res, next) {
    const key = req.headers['apikey'] || req.headers['api-key'] || req.query.apikey;
    if (key !== API_KEY) {
        return res.status(401).json({ error: 'Chave de API inválida.' });
    }
    next();
}

// ── Iniciar / reconectar WhatsApp ─────────────────────────────
async function startWhatsApp() {
    // Garante diretório de sessão
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    console.log(`[WPP] Iniciando Baileys v${version.join('.')}...`);

    const sock = makeWASocket({
        version,
        auth:            authState,
        logger:          pino({ level: 'silent' }),
        printQRInTerminal: true,      // mostra QR no terminal também
        browser:         ['Morpheus PDV', 'Chrome', '120.0'],
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2_000,
    });

    state.sock = sock;

    // ── QR Code gerado ────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            state.status      = 'qr_ready';
            state.connected   = false;
            state.qrRaw       = qr;
            state.qrUpdatedAt = Date.now();
            // Converte para imagem base64 (PNG)
            state.qrBase64 = await QRCode.toDataURL(qr, {
                width: 300,
                margin: 2,
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
            console.log(`[WPP] Conectado! Número: ${state.phoneNumber}`);
        }

        if (connection === 'close') {
            state.connected = false;
            state.status    = 'disconnected';
            const code      = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            console.log(`[WPP] Desconectado (código ${code}). Reconectar: ${shouldReconnect}`);

            if (shouldReconnect) {
                // Aguarda 3s e reinicia
                await delay(3000);
                startWhatsApp();
            } else {
                // Logout — limpa sessão salva
                console.log('[WPP] Logout detectado — limpando sessão...');
                state.status = 'logged_out';
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
        }
    });

    // ── Salva credenciais automaticamente ─────────────────────
    sock.ev.on('creds.update', saveCreds);

    return sock;
}

// ── Formatar número para WhatsApp ─────────────────────────────
function formatPhone(phone) {
    let n = phone.replace(/\D/g, '');
    if (!n.startsWith('55') && n.length <= 11) n = '55' + n;
    // Garante formato: 5511999999999@s.whatsapp.net
    return n + '@s.whatsapp.net';
}

// ══════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════

// Health check (sem autenticação — para monitoramento)
app.get('/health', (req, res) => {
    res.json({ ok: true, status: state.status, uptime: process.uptime() });
});

// Status da conexão
app.get('/status', auth, (req, res) => {
    res.json({
        status:      state.status,
        connected:   state.connected,
        phone:       state.phoneNumber,
        qr_ready:    !!state.qrBase64,
        qr_age_ms:   state.qrUpdatedAt ? Date.now() - state.qrUpdatedAt : null,
    });
});

// QR Code em base64
app.get('/qr', auth, (req, res) => {
    if (state.connected) {
        return res.json({ error: 'Já conectado. Não há QR para exibir.' });
    }
    if (!state.qrBase64) {
        return res.status(202).json({
            error: 'QR ainda não disponível. Aguarde alguns segundos e tente novamente.',
            status: state.status,
        });
    }
    res.json({
        base64:      state.qrBase64,
        updated_at:  state.qrUpdatedAt,
        age_ms:      Date.now() - state.qrUpdatedAt,
        expires_in:  Math.max(0, 60 - Math.floor((Date.now() - state.qrUpdatedAt) / 1000)),
    });
});

// Enviar mensagem
app.post('/send', auth, async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Campos obrigatórios: phone, message' });
    }
    if (!state.connected || !state.sock) {
        return res.status(503).json({ error: 'WhatsApp não conectado. Escaneie o QR Code primeiro.' });
    }

    try {
        const jid = formatPhone(phone);
        await state.sock.sendMessage(jid, { text: message });
        res.json({ success: true, phone: jid.replace('@s.whatsapp.net', '') });
    } catch (err) {
        console.error('[WPP] Erro ao enviar:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Desconectar / logout
app.post('/logout', auth, async (req, res) => {
    try {
        if (state.sock) await state.sock.logout();
        state.connected = false;
        state.status    = 'logged_out';
        state.qrBase64  = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        res.json({ success: true, message: 'Desconectado com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reiniciar conexão (sem logout — apenas reconecta)
app.post('/reconnect', auth, async (req, res) => {
    try {
        if (state.sock) {
            state.sock.end();
        }
        await delay(1500);
        await startWhatsApp();
        res.json({ success: true, message: 'Reconectando...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Inicia servidor ───────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   Morpheus WhatsApp Server               ║`);
    console.log(`║   Porta: ${PORT.toString().padEnd(34)}║`);
    console.log(`║   API Key: ${API_KEY.substring(0,8)}...${' '.repeat(Math.max(0,28-API_KEY.length))}║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    startWhatsApp();
});

// Captura erros não tratados para evitar crash
process.on('uncaughtException',  (err) => console.error('[ERRO]', err.message));
process.on('unhandledRejection', (err) => console.error('[REJECT]', err));
