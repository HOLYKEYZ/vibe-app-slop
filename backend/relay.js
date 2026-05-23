const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3001';
const isWin = os.platform() === 'win32';

// ─── Read API keys from local configs ───────────────────────────

function readCodexConfig() {
  try {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf-8');
    const model = raw.match(/model\s*=\s*"([^"]+)"/)?.[1];
    const accessToken = raw.match(/access_token\s*=\s*"([^"]+)"/)?.[1];
    const apiKey = raw.match(/api_key\s*=\s*"([^"]+)"/)?.[1];
    const cfg = {};
    if (model) cfg.CODEX_MODEL = model;
    if (accessToken) cfg.CODEX_SESSION = accessToken;
    else if (apiKey) cfg.CODEX_SESSION = apiKey;
    return cfg;
  } catch { return {}; }
}

function readOpenCodeConfig() {
  try {
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    if (!fs.existsSync(authPath)) return {};
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    const cfg = {};
    // Find first valid API key
    for (const [provider, creds] of Object.entries(auth)) {
      const key = creds.api_key || creds.apiKey || creds.token;
      if (key) { cfg.OPENCODE_SESSION = String(key); break; }
    }
    return cfg;
  } catch { return {}; }
}

function readWindsurfConfig() {
  try {
    const configPath = path.join(os.homedir(), '.codeium', 'windsurf.json');
    if (!fs.existsSync(configPath)) return {};
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const cfg = {};
    if (raw.api_key) cfg.WINDSURF_SESSION = raw.api_key;
    return cfg;
  } catch { return {}; }
}

function readKiroConfig() {
  try {
    const configPath = path.join(os.homedir(), '.kiro', 'config.json');
    if (!fs.existsSync(configPath)) return {};
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const cfg = {};
    if (raw.access_key_id && raw.secret_access_key) {
      cfg.KIRO_SESSION = JSON.stringify({ accessKeyId: raw.access_key_id, secretAccessKey: raw.secret_access_key, region: raw.region || 'us-east-1' });
    }
    if (raw.model) cfg.KIRO_MODEL = raw.model;
    return cfg;
  } catch { return {}; }
}

function readLocalConfig() {
  return {
    ...readCodexConfig(),
    ...readOpenCodeConfig(),
    ...readWindsurfConfig(),
    ...readKiroConfig(),
  };
}

// ─── Detect CLI paths ──────────────────────────────────────────

const CODEX_CMD = process.env.CODEX_PATH || 'codex';
function getOpenCodeCmd() {
  if (isWin) {
    const fp = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'), 'OpenCode', 'opencode-cli.exe');
    try { fs.accessSync(fp); return fp; } catch {}
  }
  return 'opencode';
}

// ─── WebSocket connection ──────────────────────────────────────

let ws, reconnectTimer, sessionCode;

function connect() {
  if (ws) { ws.close(); ws = null; }
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    const config = readLocalConfig();
    ws.send(JSON.stringify({ type: 'register_relay', config }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'relay_registered') {
      sessionCode = msg.code;
      console.log(`\n🔗 Session code: ${sessionCode}`);
      printQR(msg.code);
      return;
    }

    if (msg.type === 'execute') {
      const { agent, prompt, clientId } = msg;
      console.log(`\n📩 Execute: ${agent} ← "${prompt.slice(0, 60)}..."`);
      await executeAgent(agent, prompt, clientId);
    } else if (msg.type === 'system' || msg.type === 'phone_connected') {
      console.log(`ℹ️  ${msg.type}: ${msg.content || ''}`);
    }
  });

  ws.on('close', () => {
    console.log('❌ Disconnected. Reconnecting in 5s...');
    ws = null;
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error(`⚠️  ${err.message}`);
    ws = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  });
}

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function printQR(code) {
  const qrPayload = `${SERVER_URL}?code=${code}`;
  QRCode.toString(qrPayload, { type: 'terminal', small: true }, (err, qr) => {
    if (err) return;
    console.log(`\n📱 Scan to connect:`);
    console.log(qr);
    console.log(`   WS: ${qrPayload}`);
    console.log(`   Code: ${code}\n`);
  });
}

// ─── Agent execution ───────────────────────────────────────────

function executeAgent(agent, prompt, clientId) {
  return new Promise((resolve) => {
    let cmd, args;
    switch (agent.toLowerCase()) {
      case 'codex': cmd = CODEX_CMD; args = ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt]; break;
      case 'opencode': cmd = getOpenCodeCmd(); args = ['run', '--dangerously-skip-permissions', '--format', 'json', prompt]; break;
      default: send({ type: 'error', clientId, content: `Unknown agent: ${agent}` }); resolve(); return;
    }

    console.log(`  $ ${cmd} ${args.join(' ')}`);
    send({ type: 'status', clientId, content: `🔄 Running ${agent} locally...` });

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let doneSent = false, fullOutput = '', jsonBuffer = '';

    function handleData(data) {
      const text = data.toString();
      fullOutput += text;

      if (agent.toLowerCase() === 'opencode') {
        jsonBuffer += text;
        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try { const ev = JSON.parse(line); if (ev.type === 'content' && ev.content) send({ type: 'replace_stream', clientId, content: ev.content }); }
          catch { send({ type: 'stream', clientId, content: line + '\n' }); }
        }
      } else {
        send({ type: 'stream', clientId, content: text });
      }
    }

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);
    child.on('error', (err) => { if (!doneSent) { doneSent = true; send({ type: 'error', clientId, content: `Failed: ${err.message}` }); resolve(); } });
    child.on('close', (code) => {
      if (!doneSent) { doneSent = true; send({ type: 'done', clientId, content: code === 0 ? `\n✅ ${agent} done.` : `\n⚠️ ${agent} exit ${code}` }); }
      resolve();
    });
    setTimeout(() => { if (!doneSent) { doneSent = true; child.kill(); send({ type: 'done', clientId, content: `\n⏱️ ${agent} timed out.` }); resolve(); } }, 10 * 60 * 1000);
  });
}

// ─── Start ─────────────────────────────────────────────────────

console.log('═══════════════════════════════════════');
console.log('  Agent Hub — Desktop Relay');
console.log('═══════════════════════════════════════');
console.log(`  Codex:    ${CODEX_CMD}`);
console.log(`  OpenCode: ${getOpenCodeCmd()}`);
console.log(`  Server:   ${SERVER_URL}`);

const localCfg = readLocalConfig();
const found = Object.keys(localCfg);
console.log(`  Config:   ${found.length ? found.join(', ') : 'none found (manual entry needed)'}`);
console.log('═══════════════════════════════════════\n');

connect();

process.on('SIGINT', () => {
  clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit(0);
});
