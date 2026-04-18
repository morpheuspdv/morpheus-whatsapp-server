/**
 * Morpheus WhatsApp Server
 * Servidor HTTP prÃ³prio baseado em Baileys (open source)
 * ExpÃµe a mesma API da Evolution API â compatÃ­vel com o sistema Morpheus
 *
 * Endpoints:
 *   GET  /status           â estado da conexÃ£o
 *   GET  /qr               â QR Code em base64 (para exibir no sistema)
 *   POST /send             â enviar mensagem { phone, message }
 *   POST /logout           â desconectar sessÃ£o
 *   GET  /health           â healthcheck
 *
 * AutenticaÃ§Ã£o: header  apikey: SUA_CHAVE
 */

require('dotenv').config();

const express  = require('express');
const QRCode   = require('qrcode');
const pino     = require('pino');
const path     = require('path');
const fs       = require('fs');

// ââ Importa Baileys âââââââââââââââââââââââââââââââââââââââââââ
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    delay,
} = require('@whiskeysockets/baileys');

// ââ ConfiguraÃ§Ãµes âââââââââââââââââââââââââââââââââââââââââââââ
const PORT          = process.env.PORT          || 65002;
const API_KEY       = process.env.API_KEY       || 'morpheus-wpp-2026';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'morpheus-pdv';
const AUTH_DIR      = path.join(__dirname, 'auth_session');
const LOG_LEVEL     = process.env.LOG_LEVEL     || 'silent';

const logger = pino({ level: LOG_LEVEL });
const app    = express();
app.use(express.json());

// ââ Estado global âââââââââââââââââââââââââââââââââââââââââââââ
const state = {
    sock:        null,
    connected:   false,
    qrBase64:    null,       // QR atual em base64
    qrRaw:       null,       // string crua do QR
    qrUpdatedAt: 0,
    status:      'disconnected',  // disconnected | qr_ready | connected
    phoneNumber: null,
};

// ââ Middleware de autenticaÃ§Ã£o âââââââââââââââââââââââââââââââââ
function auth(req, res, next) {
    const key = req.headers['apikey'] || req.headers['api-key'] || req.query.apikey;
    if (key !== API_KEY) {
        return res.status(401).json({ error: 'Chave de API invÃ¡lida.' });
    }
    next();
}

// ââ Iniciar / reconectar WhatsApp âââââââââââââââââââââââââââââ
let _reconnectCount = 0;

async function startWhatsApp() {
    // Garante diretÃ³rio de sessÃ£o
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // fetchLatestBaileysVersion pode falhar â usamos versÃ£o estÃ¡vel como fallback
    let version = [2, 3000, 1015901307];
    try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
    } catch (e) {
        console.log('[WPP] NÃ£o foi possÃ­vel buscar versÃ£o atual, usando fallback:', version.join('.'));
    }

    console.log(`[WPP] Iniciando Baileys v${version.join('.')}...`);

    const sock = makeWASocket({
        version,
        auth:            authState,
        logger:          pino({ level: 'silent' }),
        printQRInTerminal: true,      // mostra QR no terminal tambÃ©m
        browser:         ['Morpheus PDV', 'Chrome', '120.0'],
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2_000,
    });

    state.sock = sock;

    // ââ QR Code gerado ââââââââââââââââââââââââââââââââââââââââ
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
            console.log('[WPP] QR Code pronto â escaneie no celular');
        }

        if (connection === 'open') {
            state.connected   = true;
            state.status      = 'connected';
            state.qrBase64    = null;
            state.qrRaw       = null;
            state.phoneNumber = sock.user?.id?.split(':')[0] ?? null;
            _reconnectCount   = 0; // reseta backoff
            console.log(`[WPP] Conectado! NÃºmero: ${state.phoneNumber}`);
        }

        if (connection === 'close') {
            state.connected = false;
            state.status    = 'disconnected';
            const code      = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            console.log(`[WPP] Desconectado (cÃ³digo ${code}). Reconectar: ${shouldReconnect}`);

            if (shouldReconnect) {
                _reconnectCount++;
                const waitMs = Math.min(3000 * _reconnectCount, 30000); // backoff atÃ© 30s
                console.log(`[WPP] Aguardando ${waitMs}ms antes de reconectar (tentativa ${_reconnectCount})...`);
                await delay(waitMs);
                startWhatsApp();
            } else {
                // Logout â limpa sessÃ£o salva
                console.log('[WPP] Logout detectado â limpando sessÃ£o...');
                state.status = 'logged_out';
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
        }
    });

    // ââ Salva credenciais automaticamente âââââââââââââââââââââ
    sock.ev.on('creds.update', saveCreds);

    return sock;
}

// ââ Formatar nÃºmero para WhatsApp âââââââââââââââââââââââââââââ
function formatPhone(phone) {
    let n = phone.replace(/\D/g, '');
    if (!n.startsWith('55') && n.length <= 11) n = '55' + n;
    // Garante formato: 5511999999999@s.whatsapp.net
    return n + '@s.whatsapp.net';
}

// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
//  ROTAS
// ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Health check (sem autenticaÃ§Ã£o â para monitoramento)
app.get('/health', (req, res) => {
    res.json({ ok: true, status: state.status, uptime: process.uptime() });
});

// Status da conexÃ£o
app.get('/status', auth, (req, res) => {
    res.json({
        status:      state.status,
        connected:   state.connected,
        phone:       state.phoneNumber,
        qr_ready:    !!state.qrBase64,
        qr_age_ms:   state.qrUpdatedAt ? Date.now() - state.qrUpdatedAt : null,
    });
});

// ââ Compatibilidade Evolution API âââââââââââââââââââââââââââââ

// Listar instÃ¢ncias
app.get('/instance/fetchInstances', auth, (req, res) => {
    res.json([{ instanceName: INSTANCE_NAME, instance: { instanceName: INSTANCE_NAME, status: state.status } }]);
});

// Estado da conexÃ£o
app.get('/instance/connectionState/:instance', auth, (req, res) => {
    const evState = state.connected ? 'open' : (state.status === 'qr_ready' ? 'connecting' : 'close');
    res.json({ instance: { instanceName: req.params.instance, state: evState } });
});

// Conectar / buscar QR Code
app.get('/instance/connect/:instance', auth, async (req, res) => {
    if (state.connected) {
        return res.json({ instance: { instanceName: req.params.instance, state: 'open' } });
    }
    // Aguarda QR ficar disponÃ­vel (atÃ© 8s)
    let waited = 0;
    while (!state.qrBase64 && waited < 8000) {
        await delay(500);
        waited += 500;
    }
    if (!state.qrBase64) {
        return res.status(202).json({ error: 'QR ainda nÃ£o disponÃ­vel. Tente novamente em instantes.' });
    }
    res.json({ base64: state.qrBase64, qrcode: { base64: state.qrBase64 } });
});

// Criar instÃ¢ncia (no-op â jÃ¡ existe)
app.post('/instance/create', auth, (req, res) => {
    res.json({ instance: { instanceName: INSTANCE_NAME, status: 'created' } });
});

// Logout / desconectar instÃ¢ncia
app.delete('/instance/logout/:instance', auth, async (req, res) => {
    try {
        if (state.sock) await state.sock.logout();
        state.connected = false;
        state.status    = 'logged_out';
        state.qrBase64  = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Enviar mensagem (formato Evolution API)
app.post('/message/sendText/:instance', auth, async (req, res) => {
    const { number, text } = req.body;
    if (!number || !text) return res.status(400).json({ error: 'Campos obrigatÃ³rios: number, text' });
    if (!state.connected || !state.sock) return res.status(503).json({ error: 'WhatsApp nÃ£o conectado.' });
    try {
        let n = number.replace(/\D/g, '');
        if (!n.startsWith('55') && n.length <= 11) n = '55' + n;
        await state.sock.sendMessage(n + '@s.whatsapp.net', { text });
        res.json({ key: { id: Date.now().toString() }, status: 'PENDING' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// QR Code em base64
app.get('/qr', auth, (req, res) => {
    if (state.connected) {
        return res.json({ error: 'JÃ¡ conectado. NÃ£o hÃ¡ QR para exibir.' });
    }
    if (!state.qrBase64) {
        return res.status(202).json({
            error: 'QR ainda nÃ£o disponÃ­vel. Aguarde alguns segundos e tente novamente.',
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
        return res.status(400).json({ error: 'Campos obrigatÃ³rios: phone, message' });
    }
    if (!state.connected || !state.sock) {
        return res.status(503).json({ error: 'WhatsApp nÃ£o conectado. Escaneie o QR Code primeiro.' });
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
        fs.rmSync(AUTH_DIR, { recursite: true, force: true });
        res.json({ success: true, message: 'Desconectado com sucesso.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reiniciar conexÃ£o (sem logout â apenas reconecta)
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

// ââ Inicia servidor âââââââââââââââââââââââââââââââââââââââââââ
app.listen(PORT, () => {
    console.log(`\nââââââââââââââââââââââââââââââââââââââââââââ`);
    console.log(`â   Morpheus WhatsApp Server               â`);
    console.log(`â   Porta: ${PORT.toString().padEnd(34)}â`);
    console.log(`â   API Key: ${API_KEY.substring(0,8)}...${' '.repeat(Math.max(0,28-API_KEY.length))}â`);
    console.log(`ââââââââââââââââââââââââââââââââââââââââââââ\n`);
    startWhatsApp();
});

// Captura erros nÃ£o tratados para evitar crash
process.on('uncaughtException',  (err) => console.error('[ERRO]', err.message));
process.on('unhandledRejection', (err) => console.error('[REJECT]', err));
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

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    delay,
} = require('@whiskeysockets/baileys');

const PORT          = process.env.PORT          || 65002;
const API_KEY       = process.env.API_KEY       || 'morpheus-wpp-2026';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'morpheus-pdv';
const AUTH_DIR      = path.join(__dirname, 'auth_session');
const LOG_LEVEL     = process.env.LOG_LEVEL     || 'silent';

const logger = pino({ level: LOG_LEVEL });
const app    = express();
app.use(express.json());

const state = {
    sock:        null,
    connected:   false,
    qrBase64:    null,
    qrRaw:       null,
    qrUpdatedAt: 0,
    status:      'disconnected',
    phoneNumber: null,
};

function auth(req, res, next) {
    const key = req.headers['apikey'] || req.headers['api-key'] || req.query.apikey;
    if (key !== API_KEY) {
        return res.status(401).json({ error: 'Chave de API inválida.' });
    }
    next();
}

let _reconnectCount = 0;

async function startWhatsApp() {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version = [2, 3000, 1015901307];
    try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
    } catch (e) {
        console.log('[WPP] Usando versão fallback:', version.join('.'));
    }

    console.log(`[WPP] Iniciando Baileys v${version.join('.')}...`);

    const sock = makeWASocket({
        version,
        auth:            authState,
        logger:          pino({ level: 'silent' }),
        printQRInTerminal: true,
        browser:         ['Morpheus PDV', 'Chrome', '120.0'],
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2_000,
    });

    state.sock = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            state.status      = 'qr_ready';
            state.connected   = false;
            state.qrRaw       = qr;
            state.qrUpdatedAt = Date.now();
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
            _reconnectCount   = 0;
            console.log(`[WPP] Conectado! Número: ${state.phoneNumber}`);
        }

        if (connection === 'close') {
            state.connected = false;
            state.status    = 'disconnected';
            const code      = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            console.log(`[WPP] Desconectado (código ${code}). Reconectar: ${shouldReconnect}`);

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

function formatPhone(phone) {
    let n = phone.replace(/\D/g, '');
    if (!n.startsWith('55') && n.length <= 11) n = '55' + n;
    return n + '@s.whatsapp.net';
}

app.get('/health', (req, res) => {
    res.json({ ok: true, status: state.status, uptime: process.uptime() });
});

app.get('/status', auth, (req, res) => {
    res.json({
        status:      state.status,
        connected:   state.connected,
        phone:       state.phoneNumber,
        qr_ready:    !!state.qrBase64,
        qr_age_ms:   state.qrUpdatedAt ? Date.now() - state.qrUpdatedAt : null,
    });
});

app.get('/instance/fetchInstances', auth, (req, res) => {
    res.json([{ instanceName: INSTANCE_NAME, instance: { instanceName: INSTANCE_NAME, status: state.status } }]);
});

app.get('/instance/connectionState/:instance', auth, (req, res) => {
    const evState = state.connected ? 'open' : (state.status === 'qr_ready' ? 'connecting' : 'close');
    res.json({ instance: { instanceName: req.params.instance, state: evState } });
});

app.get('/instance/connect/:instance', auth, async (req, res) => {
    if (state.connected) {
        return res.json({ instance: { instanceName: req.params.instance, state: 'open' } });
    }
    let waited = 0;
    while (!state.qrBase64 && waited < 8000) {
        await delay(500);
        waited += 500;
    }
    if (!state.qrBase64) {
        return res.status(202).json({ error: 'QR ainda não disponível. Tente novamente em instantes.' });
    }
    res.json({ base64: state.qrBase64, qrcode: { base64: state.qrBase64 } });
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
        await state.sock.sendMessage(n + '@s.whatsapp.net', { text });
        res.json({ key: { id: Date.now().toString() }, status: 'PENDING' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

app.post('/reconnect', auth, async (req, res) => {
    try {
        if (state.sock) state.sock.end();
        await delay(1500);
        await startWhatsApp();
        res.json({ success: true, message: 'Reconectando...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║   Morpheus WhatsApp Server               ║`);
    console.log(`║   Porta: ${PORT.toString().padEnd(34)}║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
    startWhatsApp();
});

process.on('uncaughtException',  (err) => console.error('[ERRO]', err.message));
process.on('unhandledRejection', (err) => console.error('[REJECT]', err));/**
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
const PORT          = process.env.PORT          || 65002;
const API_KEY       = process.env.API_KEY       || 'morpheus-wpp-2026';
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'morpheus-pdv';
const AUTH_DIR      = path.join(__dirname, 'auth_session');
const LOG_LEVEL     = process.env.LOG_LEVEL     || 'silent';

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

// ── Compatibilidade Evolution API ─────────────────────────────

// Listar instâncias
app.get('/instance/fetchInstances', auth, (req, res) => {
    res.json([{ instanceName: INSTANCE_NAME, instance: { instanceName: INSTANCE_NAME, status: state.status } }]);
});

// Estado da conexão
app.get('/instance/connectionState/:instance', auth, (req, res) => {
    const evState = state.connected ? 'open' : (state.status === 'qr_ready' ? 'connecting' : 'close');
    res.json({ instance: { instanceName: req.params.instance, state: evState } });
});

// Conectar / buscar QR Code
app.get('/instance/connect/:instance', auth, async (req, res) => {
    if (state.connected) {
        return res.json({ instance: { instanceName: req.params.instance, state: 'open' } });
    }
    // Aguarda QR ficar disponível (até 8s)
    let waited = 0;
    while (!state.qrBase64 && waited < 8000) {
        await delay(500);
        waited += 500;
    }
    if (!state.qrBase64) {
        return res.status(202).json({ error: 'QR ainda não disponível. Tente novamente em instantes.' });
    }
    res.json({ base64: state.qrBase64, qrcode: { base64: state.qrBase64 } });
});

// Criar instância (no-op — já existe)
app.post('/instance/create', auth, (req, res) => {
    res.json({ instance: { instanceName: INSTANCE_NAME, status: 'created' } });
});

// Logout / desconectar instância
app.delete('/instance/logout/:instance', auth, async (req, res) => {
    try {
        if (state.sock) await state.sock.logout();
        state.connected = false;
        state.status    = 'logged_out';
        state.qrBase64  = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Enviar mensagem (formato Evolution API)
app.post('/message/sendText/:instance', auth, async (req, res) => {
    const { number, text } = req.body;
    if (!number || !text) return res.status(400).json({ error: 'Campos obrigatórios: number, text' });
    if (!state.connected || !state.sock) return res.status(503).json({ error: 'WhatsApp não conectado.' });
    try {
        let n = number.replace(/\D/g, '');
        if (!n.startsWith('55') && n.length <= 11) n = '55' + n;
        await state.sock.sendMessage(n + '@s.whatsapp.net', { text });
        res.json({ key: { id: Date.now().toString() }, status: 'PENDING' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
