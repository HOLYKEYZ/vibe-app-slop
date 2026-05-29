// @ts-nocheck
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const SESSIONS_FILE = process.env.AGENTHUB_SESSIONS_FILE || path.join(__dirname, 'sessions.json');
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const DEFAULTS = {
  codex:    process.env.CODEX_MODEL      || 'gpt-5.5',
  opencode: process.env.OPENCODE_MODEL   || 'gpt-5.5',
};

const AGENT_MODELS = {
  codex:    ['gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5.5'],
  opencode: ['gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5.5', 'o3-mini', 'gpt-4.1-nano'],
};
const MODEL_KEY = { codex: 'CODEX_MODEL', opencode: 'OPENCODE_MODEL' };

const sessions = new Map();

function isValidCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(code);
}

function ensurePhoneSockets(session) {
  if (!session.phoneWss) session.phoneWss = new Set();
  return session.phoneWss;
}

function sendToPhones(session, obj) {
  const targets = new Set();
  if (session?.phoneWs) targets.add(session.phoneWs);
  for (const phone of ensurePhoneSockets(session)) targets.add(phone);
  for (const phone of targets) {
    if (phone?.readyState === 1) send(phone, obj);
  }
}

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      for (const [code, s] of Object.entries(data)) {
        sessions.set(code, { ...s, relayWs: null, phoneWs: null, phoneWss: new Set(), reconnectTimer: null });
      }
      console.log(`Loaded ${Object.keys(data).length} persisted sessions`);
    }
  } catch (e) { console.error('Failed to load sessions:', e.message); }
}

function saveSessions() {
  try {
    const obj = {};
    for (const [code, s] of sessions) {
      obj[code] = { code: s.code, config: s.config, createdAt: s.createdAt, state: s.state };
    }
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) { console.error('Failed to save sessions:', e.message); }
}

function generateCode() {
  const b = crypto.randomBytes(10);
  let c = '';
  for (let i = 0; i < 10; i++) c += CHARSET[b[i] % CHARSET.length];
  return c;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function getRelayOnline(session) {
  return session?.relayWs?.readyState === 1;
}

function getLocalAgents(session) {
  return Array.isArray(session?.config?.LOCAL_AGENTS) ? session.config.LOCAL_AGENTS : [];
}

function getAvailableModels(session) {
  const localAgents = new Set(getLocalAgents(session));
  return Object.fromEntries(Object.entries(AGENT_MODELS).filter(([agent]) => localAgents.has(agent)));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    const m = [...sessions.values()];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: m.length, activeRelays: m.filter(s => s.relayWs?.readyState === 1).length }));
    return;
  }
  if (url.pathname === '/connect' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing code' })); return; }
    const s = sessions.get(code);
    if (!s || s.state === 'expired') { res.writeHead(404); res.end(JSON.stringify({ error: 'Session not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      code: s.code, state: s.state, createdAt: s.createdAt,
      relayOnline: s.relayWs?.readyState === 1,
      agents: getLocalAgents(s),
    }));
    return;
  }
  if (url.pathname === '/download' || url.pathname === '/') {
    const apkPaths = [
      path.join(__dirname, '..', 'AgentHub', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
      path.join(__dirname, 'app-debug.apk'),
    ];
    const apkPath = apkPaths.find(p => fs.existsSync(p));
    const hasApk = !!apkPath;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Hub</title><style>
      *{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,sans-serif;background:#0a0a0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
      .card{background:linear-gradient(135deg,#1a1a2e,#16213e);border:1px solid rgba(139,92,246,.3);border-radius:20px;padding:40px 30px;text-align:center;max-width:400px;width:100%}
      .icon{font-size:64px;margin-bottom:16px}h1{font-size:28px;margin-bottom:8px}p{color:#888;margin-bottom:24px;font-size:14px}
      .btn{display:inline-block;background:linear-gradient(135deg,#8B5CF6,#6D28D9);color:#fff;text-decoration:none;padding:16px 40px;border-radius:12px;font-size:18px;font-weight:600}
      .hint{color:#555;font-size:12px;margin-top:20px}input{padding:10px;border-radius:8px;border:0;width:100%;margin:8px 0;background:#1e1e24;color:#fff;font-size:14px}
    </style></head><body>
    <div class="card">
      <div class="icon">🤖</div>
      <h1>Agent Hub</h1>
      <p>Control Codex and OpenCode from your phone</p>
      ${hasApk ? `<a href="/apk" class="btn">⬇ Install APK (${(fs.statSync(apkPath).size / 1024 / 1024).toFixed(1)} MB)</a>` : `<p style="color:#e88">APK not on this server.</p><p class="hint">Build locally with <code>cd AgentHub && ./gradlew assembleDebug</code> then run <code>node serve-apk.js</code> on your LAN.</p>`}
      <p class="hint">After installing, open the app and scan the QR code from your laptop's relay terminal.</p>
    </div></body></html>`);
    return;
  }
  if (url.pathname === '/apk' && (req.method === 'GET' || req.method === 'HEAD')) {
    const apkPaths = [
      path.join(__dirname, '..', 'AgentHub', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
      path.join(__dirname, 'app-debug.apk'),
    ];
    const apkPath = apkPaths.find(p => fs.existsSync(p));
    if (!apkPath) { res.writeHead(404); res.end('APK not found'); return; }
    const stat = fs.statSync(apkPath);
    res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="AgentHub.apk"', 'Content-Length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(apkPath).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Agent Hub Backend — see /download');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws._code = null;
  ws._role = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send(ws, { type: 'error', content: 'Invalid JSON' }); return; }

    if (msg.type === 'ping') {
      send(ws, { type: 'pong', ts: Date.now() });
      return;
    }

    if (msg.type === 'register_relay') {
      const preferredCode = isValidCode(msg.preferredCode) ? msg.preferredCode : null;
      const code = preferredCode || generateCode();
      const existing = sessions.get(code);
      if (existing?.relayWs && existing.relayWs !== ws) {
        try { existing.relayWs.close(1000, 'Relay replaced by reconnect'); } catch {}
      }
      const session = existing || { code, relayWs: null, phoneWs: null, phoneWss: new Set(), config: {}, createdAt: Date.now(), state: 'active', reconnectTimer: null };
      session.relayWs = ws;
      session.config = { ...(session.config || {}), ...(msg.config || {}) };
      session.state = 'active';
      sessions.set(code, session);
      ws._code = code; ws._role = 'relay';
      send(ws, { type: 'relay_registered', code, reused: !!existing });
      sendToPhones(session, { type: 'status', content: 'Desktop relay online.' });
      const agentModel = {};
      for (const [a, key] of Object.entries(MODEL_KEY)) { if (session.config?.[key]) agentModel[a] = session.config[key]; }
      sendToPhones(session, {
        type: 'session_joined',
        code,
        relay_online: true,
        available_models: getAvailableModels(session),
        available_agents: getLocalAgents(session),
        agent_model: agentModel,
      });
      saveSessions();
      console.log(`[relay] ${code} ${existing ? 'reconnected' : 'registered'}`);
      return;
    }

    if (msg.type === 'join_session') {
      const { code } = msg;
      const s = sessions.get(code);
      if (!s || s.state === 'expired') { send(ws, { type: 'error', content: 'Session expired' }); return; }
      s.phoneWs = ws;
      ensurePhoneSockets(s).add(ws);
      ws._code = code; ws._role = 'phone';
      if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
      const agentModel = {};
      for (const [a, key] of Object.entries(MODEL_KEY)) { if (s.config?.[key]) agentModel[a] = s.config[key]; }
      send(ws, { type: 'session_joined', code, relay_online: getRelayOnline(s), available_models: getAvailableModels(s), available_agents: getLocalAgents(s), agent_model: agentModel });
      if (getRelayOnline(s)) send(s.relayWs, { type: 'phone_connected' });
      saveSessions();
      console.log(`[phone] ${code} joined`);
      return;
    }

    if (msg.type === 'select_model') {
      const s = ws._code ? sessions.get(ws._code) : null;
      if (!s) { send(ws, { type: 'error', content: 'No session' }); return; }
      const key = MODEL_KEY[msg.agent];
      if (key) { s.config[key] = msg.model; saveSessions(); }
      send(ws, { type: 'config_updated', config: s.config });
      return;
    }

    if (msg.type === 'relay_update_config') {
      const s = ws._code ? sessions.get(ws._code) : null;
      if (s && ws._role === 'relay') {
        Object.assign(s.config, msg.config || {});
        sendToPhones(s, { type: 'config_updated', config: s.config });
        send(ws, { type: 'system', content: 'Config updated' });
        saveSessions();
      }
      return;
    }

    const s = ws._code ? sessions.get(ws._code) : null;
    if (!s) { send(ws, { type: 'error', content: 'No session. Register relay or join with code first.' }); return; }

    if (ws._role === 'relay' && msg.clientId) {
      const t = sessions.get(msg.clientId);
      if (t) {
        const forwarded = { ...msg };
        delete forwarded.clientId;
        sendToPhones(t, forwarded);
      }
      return;
    }

    if (ws._role === 'phone' && ['session_list', 'session_detail'].includes(msg.type)) {
      if (!getRelayOnline(s)) {
        send(ws, { type: 'error', content: 'Desktop relay offline. Wake the laptop and restart the relay.' });
        return;
      }
      send(s.relayWs, { ...msg, clientId: s.code });
      return;
    }

    const { agent, prompt } = msg;
    if (!agent || !prompt) { send(ws, { type: 'error', content: 'Missing agent or prompt' }); return; }

    // Phone → Relay
    if (ws._role === 'phone' && getRelayOnline(s)) {
      send(s.relayWs, { type: 'execute', agent, prompt, sessionId: msg.sessionId || '', attachments: msg.attachments || [], clientId: s.code });
      return;
    }

    // Relay → Phone (stream results)
    if (ws._role === 'relay' && msg.clientId) {
      const t = sessions.get(msg.clientId);
      if (t) sendToPhones(t, { type: msg.type, content: msg.content });
      return;
    }

    // Phone without relay: local agents only, no server-side API fallback.
    if (ws._role === 'phone' && !getRelayOnline(s)) {
      send(ws, { type: 'error', content: 'Desktop relay offline. Wake the laptop and restart the relay.' });
      return;
    }
  });

  ws.on('close', () => {
    const s = ws._code ? sessions.get(ws._code) : null;
    if (!s) return;
    if (ws._role === 'relay') {
      if (s.relayWs === ws) {
        s.relayWs = null;
        sendToPhones(s, { type: 'status', content: 'Desktop relay offline. Local agents unavailable.' });
        saveSessions();
      }
    } else if (ws._role === 'phone') {
      ensurePhoneSockets(s).delete(ws);
      if (s.phoneWs === ws) s.phoneWs = null;
    }
  });
});

loadSessions();

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Hub Backend on port ${PORT}`);
});
