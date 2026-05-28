const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { BedrockRuntimeClient, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');

const PORT = process.env.PORT || 3001;
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const DEFAULTS = {
  codex:    process.env.CODEX_MODEL      || 'gpt-5.5',
  opencode: process.env.OPENCODE_MODEL   || 'gpt-5.5',
  windsurf: process.env.WINDSURF_MODEL   || 'gpt-4o',
  kiro:     process.env.KIRO_MODEL       || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  kiroRegion: process.env.KIRO_REGION    || 'us-east-1',
};

const AGENT_MODELS = {
  codex:    ['gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5.5'],
  opencode: ['gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5.5', 'o3-mini', 'gpt-4.1-nano'],
  windsurf: ['gpt-4o', 'gpt-4.1'],
  kiro:     ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'anthropic.claude-3-opus-20240229', 'anthropic.claude-3-haiku-20240307', 'anthropic.claude-3-5-haiku-20241022'],
};
const MODEL_KEY = { codex: 'CODEX_MODEL', opencode: 'OPENCODE_MODEL', windsurf: 'WINDSURF_MODEL', kiro: 'KIRO_MODEL' };

const sessions = new Map();

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
      for (const [code, s] of Object.entries(data)) {
        sessions.set(code, { ...s, relayWs: null, phoneWs: null, reconnectTimer: null });
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

function extractSseText(event) {
  return event.choices?.[0]?.delta?.content
    || event.choices?.[0]?.text
    || event.delta
    || event.output_text
    || event.message?.content?.parts?.[0]
    || event.response?.output_text
    || '';
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
      agents: Object.keys(s.config || {}).filter(k => k.endsWith('_SESSION')).map(k => k.replace('_SESSION', '').toLowerCase()),
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
      <p>Control Codex, OpenCode, Windsurf &amp; Kiro from your phone</p>
      ${hasApk ? `<a href="/apk" class="btn">⬇ Install APK (${(fs.statSync(apkPath).size / 1024 / 1024).toFixed(1)} MB)</a>` : `<p style="color:#e88">APK not on this server.</p><p class="hint">Build locally with <code>cd AgentHub && ./gradlew assembleDebug</code> then run <code>node serve-apk.js</code> on your LAN.</p>`}
      <p class="hint">After installing, open the app and scan the QR code from your laptop's relay terminal.</p>
    </div></body></html>`);
    return;
  }
  if (url.pathname === '/apk' && req.method === 'GET') {
    const apkPaths = [
      path.join(__dirname, '..', 'AgentHub', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
      path.join(__dirname, 'app-debug.apk'),
    ];
    const apkPath = apkPaths.find(p => fs.existsSync(p));
    if (!apkPath) { res.writeHead(404); res.end('APK not found'); return; }
    const stat = fs.statSync(apkPath);
    res.writeHead(200, { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="AgentHub.apk"', 'Content-Length': stat.size });
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
      const code = generateCode();
      const session = { code, relayWs: ws, phoneWs: null, config: msg.config || {}, createdAt: Date.now(), state: 'active', reconnectTimer: null };
      sessions.set(code, session);
      ws._code = code; ws._role = 'relay';
      send(ws, { type: 'relay_registered', code });
      saveSessions();
      console.log(`[relay] ${code} registered`);
      return;
    }

    if (msg.type === 'join_session') {
      const { code } = msg;
      const s = sessions.get(code);
      if (!s || s.state === 'expired') { send(ws, { type: 'error', content: 'Session expired' }); return; }
      s.phoneWs = ws;
      ws._code = code; ws._role = 'phone';
      if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
      const agentModel = {};
      for (const [a, key] of Object.entries(MODEL_KEY)) { if (s.config?.[key]) agentModel[a] = s.config[key]; }
      send(ws, { type: 'session_joined', code, relay_online: getRelayOnline(s), available_models: AGENT_MODELS, agent_model: agentModel });
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
        if (s.phoneWs?.readyState === 1) send(s.phoneWs, { type: 'config_updated', config: s.config });
        send(ws, { type: 'system', content: 'Config updated' });
        saveSessions();
      }
      return;
    }

    const s = ws._code ? sessions.get(ws._code) : null;
    if (!s) { send(ws, { type: 'error', content: 'No session. Register relay or join with code first.' }); return; }

    if (ws._role === 'relay' && msg.clientId) {
      const t = sessions.get(msg.clientId);
      if (t?.phoneWs?.readyState === 1) {
        send(t.phoneWs, { type: msg.type, content: msg.content || '' });
      }
      return;
    }

    const { agent, prompt } = msg;
    if (!agent || !prompt) { send(ws, { type: 'error', content: 'Missing agent or prompt' }); return; }

    // Phone → Relay
    if (ws._role === 'phone' && getRelayOnline(s)) {
      send(s.relayWs, { type: 'execute', agent, prompt, clientId: s.code });
      return;
    }

    // Relay → Phone (stream results)
    if (ws._role === 'relay' && msg.clientId) {
      const t = sessions.get(msg.clientId);
      if (t?.phoneWs?.readyState === 1) send(t.phoneWs, { type: msg.type, content: msg.content });
      return;
    }

    // Phone → Cloud (relay offline)
    if (ws._role === 'phone' && !getRelayOnline(s)) {
      send(ws, { type: 'status', content: '⚡ Relay offline — using cloud mode directly' });
      try {
        const cfg = s.config || {};
        switch (agent.toLowerCase()) {
          case 'codex':    await runCodexCloud(ws, cfg, prompt); break;
          case 'opencode': await runOpenCodeCloud(ws, cfg, prompt); break;
          case 'windsurf': await runWindsurfCloud(ws, cfg, prompt); break;
          case 'kiro':     await runKiroCloud(ws, cfg, prompt); break;
          default: send(ws, { type: 'error', content: `Unknown agent: ${agent}` });
        }
      } catch (e) { send(ws, { type: 'error', content: `Error: ${e.message}` }); }
      return;
    }
  });

  ws.on('close', () => {
    const s = ws._code ? sessions.get(ws._code) : null;
    if (!s) return;
    if (ws._role === 'relay') {
      s.relayWs = null;
      send(s.phoneWs, { type: 'status', content: '⚡ Desktop relay offline. Using cloud mode.' });
      saveSessions();
    } else if (ws._role === 'phone') {
      s.phoneWs = null;
    }
  });
});

// ─── Cloud handlers ──────────────────────────────────────────────

async function streamSSE(response, ws) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const d = JSON.parse(line.slice(6));
          const content = extractSseText(d);
          if (content) send(ws, { type: 'stream', content });
        } catch (e) {}
      }
    }
  }
}

async function runCodexCloud(ws, cfg, prompt) {
  const m = cfg.CODEX_MODEL || DEFAULTS.codex;
  // Try each possible API key in order: OpenCode OpenAI key, then Codex JWT
  const keys = [];
  if (cfg.OPENCODE_SESSION) keys.push(cfg.OPENCODE_SESSION);
  if (cfg.CODEX_SESSION) keys.push(cfg.CODEX_SESSION);
  if (cfg.OPENCODE_PROVIDERS) {
    try {
      const p = typeof cfg.OPENCODE_PROVIDERS === 'string' ? JSON.parse(cfg.OPENCODE_PROVIDERS) : cfg.OPENCODE_PROVIDERS;
      for (const k of Object.values(p)) { if (String(k).startsWith('sk-')) keys.push(String(k)); }
    } catch {}
  }
  if (!keys.length) return send(ws, { type: 'error', content: 'No API keys available for cloud mode. Connect desktop relay to use local agents.' });
  send(ws, { type: 'status', content: `🤖 Codex (${m}) via cloud...` });
  for (const key of keys) {
    const body = { model: m, messages: [{ role: 'user', content: prompt }], stream: true };
    let resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!resp.ok) {
      resp = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m, input: prompt, stream: true }),
      });
    }
    if (resp.ok) { await streamSSE(resp, ws); send(ws, { type: 'done', content: `\n✅ Codex (${m}) complete.` }); return; }
  }
  send(ws, { type: 'error', content: 'All API keys failed for Codex. Connect desktop relay to use local agents.' });
}

async function runOpenCodeCloud(ws, cfg, prompt) {
  const session = cfg.OPENCODE_SESSION;
  if (!session) return send(ws, { type: 'error', content: 'OpenCode session not set. Connect relay or configure in settings.' });
  const userModel = cfg.OPENCODE_MODEL;
  let apiUrl, model;
  if (session.startsWith('sk-or-')) { apiUrl = 'https://openrouter.ai/api/v1/chat/completions'; model = userModel || 'openai/gpt-4o'; }
  else if (session.startsWith('gsk_')) { apiUrl = 'https://api.groq.com/openai/v1/chat/completions'; model = userModel || 'llama-3.3-70b-versatile'; }
  else if (session.startsWith('nvapi-')) { apiUrl = 'https://integrate.api.nvidia.com/v1/chat/completions'; model = userModel || 'meta/llama-3.1-70b-instruct'; }
  else if (session.startsWith('AIza')) {
    send(ws, { type: 'status', content: '🤖 OpenCode (Google AI)...' });
    const mid = userModel || 'gemini-pro';
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1/models/${mid}:streamGenerateContent?key=${session}&alt=sse`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!resp.ok) { send(ws, { type: 'error', content: `Google AI error: ${resp.status}` }); return; }
    const reader = resp.body.getReader(), decoder = new TextDecoder(); let buf = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (const line of buf.split('\n').slice(0, -1)) {
        if (line.startsWith('data: ')) { try { const d = JSON.parse(line.slice(6)); const t = d.candidates?.[0]?.content?.parts?.[0]?.text || ''; if (t) send(ws, { type: 'stream', content: t }); } catch (e) {} }
      }
      buf = buf.split('\n').pop() || '';
    }
    send(ws, { type: 'done', content: '\n✅ OpenCode complete.' }); return;
  } else {
    apiUrl = 'https://api.openai.com/v1/chat/completions'; model = userModel || DEFAULTS.opencode;
  }
  send(ws, { type: 'status', content: `🤖 OpenCode (${model})...` });
  const resp = await fetch(apiUrl, {
    method: 'POST', headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
  });
  if (!resp.ok) { const t = await resp.text().catch(() => ''); send(ws, { type: 'error', content: `OpenCode error ${resp.status}: ${t}` }); return; }
  await streamSSE(resp, ws);
  send(ws, { type: 'done', content: `\n✅ OpenCode (${model}) complete.` });
}

async function runWindsurfCloud(ws, cfg, prompt) {
  const session = cfg.WINDSURF_SESSION;
  if (!session) return send(ws, { type: 'error', content: 'Windsurf session not set. Connect relay or configure in settings.' });
  send(ws, { type: 'status', content: '🏄 Windsurf...' });
  const body = { messages: [{ role: 'user', content: prompt }] };
  if (cfg.WINDSURF_MODEL) body.model = cfg.WINDSURF_MODEL;
  try {
    const resp = await fetch('https://server.codeium.com/api/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!resp.ok) { send(ws, { type: 'stream', content: `[Windsurf] API ${resp.status}. Use relay mode.\n\nPrompt: ${prompt}` }); send(ws, { type: 'done', content: '\n⚠️ Connect desktop relay for full Windsurf access.' }); return; }
    await streamSSE(resp, ws);
    send(ws, { type: 'done', content: '\n✅ Windsurf complete.' });
  } catch (err) { send(ws, { type: 'error', content: `Windsurf error: ${err.message}` }); }
}

function parseAwsCreds(s) {
  try { const p = JSON.parse(s); return { accessKeyId: p.accessKeyId || p.access_key_id, secretAccessKey: p.secretAccessKey || p.secret_access_key, region: p.region || DEFAULTS.kiroRegion }; }
  catch { const p = s.split(':'); return { accessKeyId: p[0], secretAccessKey: p[1], region: p[2] || DEFAULTS.kiroRegion }; }
}

async function runKiroCloud(ws, cfg, prompt) {
  const session = cfg.KIRO_SESSION;
  if (!session) return send(ws, { type: 'error', content: 'Kiro session not set. Connect relay or configure in settings.' });
  const { accessKeyId, secretAccessKey, region } = parseAwsCreds(session);
  if (!accessKeyId || !secretAccessKey) return send(ws, { type: 'error', content: 'Kiro session must be JSON {"accessKeyId":"...","secretAccessKey":"...","region":"..."} or key:secret:region' });
  const modelId = cfg.KIRO_MODEL || DEFAULTS.kiro;
  send(ws, { type: 'status', content: `🔮 Kiro (${modelId})...` });
  try {
    const client = new BedrockRuntimeClient({ region, credentials: { accessKeyId, secretAccessKey } });
    const resp = await client.send(new ConverseStreamCommand({ modelId, messages: [{ role: 'user', content: [{ text: prompt }] }] }));
    for await (const event of resp.stream) {
      if (event.contentBlockDelta?.delta?.text) send(ws, { type: 'stream', content: event.contentBlockDelta.delta.text });
      else if (event.messageStop) { send(ws, { type: 'done', content: '\n✅ Kiro complete.' }); return; }
    }
    send(ws, { type: 'done', content: '\n✅ Kiro complete.' });
  } catch (err) { send(ws, { type: 'error', content: `Kiro error: ${err.message}` }); }
}

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
