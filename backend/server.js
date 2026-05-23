const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { BedrockRuntimeClient, ConverseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');

const PORT = process.env.PORT || 3001;
const RELAY_GRACE_MS = 5 * 60 * 1000;
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const DEFAULTS = {
  codex:    process.env.CODEX_MODEL      || 'gpt-5.5',
  opencode: process.env.OPENCODE_MODEL   || 'gpt-5.5',
  windsurf: process.env.WINDSURF_MODEL   || 'gpt-4o',
  kiro:     process.env.KIRO_MODEL       || 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  kiroRegion: process.env.KIRO_REGION    || 'us-east-1',
};

const sessions = new Map();

function generateCode() {
  const b = crypto.randomBytes(10);
  let c = '';
  for (let i = 0; i < 10; i++) c += CHARSET[b[i] % CHARSET.length];
  return c;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
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
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Agent Hub Backend');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws._code = null;
  ws._role = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send(ws, { type: 'error', content: 'Invalid JSON' }); return; }

    if (msg.type === 'register_relay') {
      const code = generateCode();
      const session = { code, relayWs: ws, phoneWs: null, config: msg.config || {}, createdAt: Date.now(), state: 'active', reconnectTimer: null };
      sessions.set(code, session);
      ws._code = code; ws._role = 'relay';
      send(ws, { type: 'relay_registered', code });
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
      send(ws, { type: 'session_joined', code, relay_online: s.relayWs?.readyState === 1, config: s.config || {} });
      if (s.relayWs?.readyState === 1) send(s.relayWs, { type: 'phone_connected' });
      console.log(`[phone] ${code} joined`);
      return;
    }

    if (msg.type === 'relay_update_config') {
      const s = ws._code ? sessions.get(ws._code) : null;
      if (s && ws._role === 'relay') {
        Object.assign(s.config, msg.config || {});
        if (s.phoneWs?.readyState === 1) send(s.phoneWs, { type: 'config_updated', config: s.config });
        send(ws, { type: 'system', content: 'Config updated' });
      }
      return;
    }

    const s = ws._code ? sessions.get(ws._code) : null;
    if (!s) { send(ws, { type: 'error', content: 'No session. Register relay or join with code first.' }); return; }

    const { agent, prompt } = msg;
    if (!agent || !prompt) { send(ws, { type: 'error', content: 'Missing agent or prompt' }); return; }

    // Phone → Relay
    if (ws._role === 'phone' && s.relayWs?.readyState === 1) {
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
    if (ws._role === 'phone' && (!s.relayWs || s.relayWs.readyState !== 1)) {
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
      s.relayWs = null; s.state = 'offline_grace';
      send(s.phoneWs, { type: 'status', content: '⚡ Desktop relay offline. Using cloud mode.' });
      s.reconnectTimer = setTimeout(() => {
        if (!s.relayWs) { s.state = 'expired'; send(s.phoneWs, { type: 'system', content: '❌ Relay session expired. Relaunch relay to renew.' }); }
      }, RELAY_GRACE_MS);
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
          const content = d.choices?.[0]?.delta?.content || d.choices?.[0]?.text || d.message?.content?.parts?.[0] || '';
          if (content) send(ws, { type: 'replace_stream', content });
        } catch (e) {}
      }
    }
  }
}

async function runCodexCloud(ws, cfg, prompt) {
  const session = cfg.CODEX_SESSION;
  if (!session) return send(ws, { type: 'error', content: 'Codex session not set. Connect relay or configure in settings.' });
  const m = cfg.CODEX_MODEL || DEFAULTS.codex;
  send(ws, { type: 'status', content: `🤖 Codex (${m})...` });
  const body = { model: m, messages: [{ role: 'user', content: prompt }], stream: true };
  let resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) {
    resp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Authorization': `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: m, input: prompt, stream: true }),
    });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); send(ws, { type: 'error', content: `Codex error: ${resp.status} ${t}` }); return; }
  }
  await streamSSE(resp, ws);
  send(ws, { type: 'done', content: `\n✅ Codex (${m}) complete.` });
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
        if (line.startsWith('data: ')) { try { const d = JSON.parse(line.slice(6)); const t = d.candidates?.[0]?.content?.parts?.[0]?.text || ''; if (t) send(ws, { type: 'replace_stream', content: t }); } catch (e) {} }
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
      if (event.contentBlockDelta?.delta?.text) send(ws, { type: 'replace_stream', content: event.contentBlockDelta.delta.text });
      else if (event.messageStop) { send(ws, { type: 'done', content: '\n✅ Kiro complete.' }); return; }
    }
    send(ws, { type: 'done', content: '\n✅ Kiro complete.' });
  } catch (err) { send(ws, { type: 'error', content: `Kiro error: ${err.message}` }); }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Hub Backend on port ${PORT}`);
});
