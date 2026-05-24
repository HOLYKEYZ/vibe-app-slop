const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3001';
const isWin = os.platform() === 'win32';

const AGENTS = [
  { id: 'codex',    name: 'Codex',    configKey: 'CODEX_SESSION',  modelKey: 'CODEX_MODEL',  cmd: process.env.CODEX_PATH || 'codex',               args: p => ['exec', '--dangerously-bypass-approvals-and-sandbox', p] },
  { id: 'opencode', name: 'OpenCode', configKey: 'OPENCODE_SESSION', modelKey: 'OPENCODE_MODEL', cmd: null, args: p => ['run', '--dangerously-skip-permissions', '--format', 'json', p] },
  { id: 'windsurf', name: 'Windsurf', configKey: 'WINDSURF_SESSION', modelKey: 'WINDSURF_MODEL', cmd: null, args: p => [p] },
  { id: 'kiro',     name: 'Kiro',     configKey: 'KIRO_SESSION',   modelKey: 'KIRO_MODEL',   cmd: null, args: p => [p] },
];

function getCmd(a) {
  if (a.cmd) return a.cmd;
  if (a.id === 'opencode') {
    if (isWin) {
      const fp = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'), 'OpenCode', 'opencode-cli.exe');
      try { fs.accessSync(fp); return fp; } catch {}
    }
    return 'opencode';
  }
  return a.id;
}

function readCodexConfig() {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(authPath)) return {};
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    const cfg = {};
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const model = raw.match(/model\s*=\s*"([^"]+)"/)?.[1];
      if (model) cfg.CODEX_MODEL = model;
    }
    const token = auth.tokens?.access_token;
    if (token) cfg.CODEX_SESSION = token;
    if (auth.OPENAI_API_KEY) cfg.CODEX_SESSION = auth.OPENAI_API_KEY;
    return cfg;
  } catch { return {}; }
}

function readOpenCodeConfig() {
  try {
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    if (!fs.existsSync(authPath)) return {};
    const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    const cfg = {};
    for (const [provider, creds] of Object.entries(auth)) {
      const key = creds.key || creds.api_key || creds.apiKey || creds.token;
      if (key) {
        if (!cfg.OPENCODE_SESSION) cfg.OPENCODE_SESSION = String(key);
      }
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
  return { ...readCodexConfig(), ...readOpenCodeConfig(), ...readWindsurfConfig(), ...readKiroConfig() };
}

// ─── Detect available agents ──────────────────────────────────

function getAvailableAgents() {
  const cfg = readLocalConfig();
  return AGENTS.filter(a => cfg[a.configKey]);
}

// ─── WebSocket ────────────────────────────────────────────────

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
      console.log(`\n🔗 Relay session: ${sessionCode}\n`);
      printAgentQRCodes(sessionCode);
      return;
    }

    if (msg.type === 'execute') {
      const { agent, prompt, clientId } = msg;
      console.log(`\n📩 ${agent}: "${prompt.slice(0, 80)}..."`);
      await executeAgent(agent, prompt, clientId);
    } else if (msg.type === 'system' || msg.type === 'phone_connected') {
      console.log(`ℹ️  ${msg.content || msg.type}`);
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

function printAgentQRCodes(code) {
  const agents = getAvailableAgents();
  const qrFile = path.join(__dirname, '..', 'session_qr.txt');
  let fileContent = '';

  agents.forEach((a, i) => {
    const qrPayload = `${SERVER_URL}?code=${code}&agent=${a.id}`;
    if (i > 0) console.log('');
    QRCode.toString(qrPayload, { type: 'terminal', small: true }, (err, qr) => {
      if (err) return;
      console.log(`═══════════════════════════════════════`);
      console.log(`  ${a.name}`);
      console.log(`═══════════════════════════════════════`);
      console.log(qr);
      console.log(`   Code: ${code}`);
      console.log(`   Agent: ${a.name}`);
      console.log(`═══════════════════════════════════════\n`);
    });
    fileContent += `Agent: ${a.name} (${a.id})\nCode: ${code}\nURL: ${qrPayload}\n\n`;

    // Also print a compact one-liner
    console.log(`  [${a.id}] Code: ${code}  |  URL: ${qrPayload}\n`);
  });

  if (agents.length === 0) {
    console.log('⚠️  No agents detected (no API keys found).');
    console.log('   Install and configure codex, opencode, or others.\n');
  }

  try {
    if (fileContent) fs.writeFileSync(qrFile, fileContent);
  } catch {}
}

// ─── Agent execution ──────────────────────────────────────────

function executeAgent(agent, prompt, clientId) {
  return new Promise((resolve) => {
    const a = AGENTS.find(x => x.id === agent);
    if (!a) { send({ type: 'error', clientId, content: `Unknown agent: ${agent}` }); resolve(); return; }

    const cmd = getCmd(a);
    const args = a.args(prompt);
    console.log(`  $ ${cmd} ${args.join(' ')}`);
    send({ type: 'status', clientId, content: `🔄 ${a.name}...` });

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let doneSent = false, fullOutput = '', jsonBuffer = '';

    function handleData(data) {
      const text = data.toString();
      fullOutput += text;

      if (agent === 'opencode') {
        jsonBuffer += text;
        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === 'content' && ev.content) {
              send({ type: 'replace_stream', clientId, content: ev.content });
            }
          } catch {
            // Skip non-JSON lines (progress spinners, status, etc.)
          }
        }
      } else if (agent === 'codex') {
        // Codex output is mostly AI text. Forward cleanly, strip ANSI.
        send({ type: 'replace_stream', clientId, content: text });
      } else {
        send({ type: 'stream', clientId, content: text });
      }
    }

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);
    child.on('error', (err) => { if (!doneSent) { doneSent = true; send({ type: 'error', clientId, content: `Failed: ${err.message}` }); resolve(); } });
    child.on('close', (code) => {
      if (!doneSent) { doneSent = true; send({ type: 'done', clientId, content: code === 0 ? '' : `\n⚠️ Exit ${code}` }); }
      resolve();
    });
    setTimeout(() => { if (!doneSent) { doneSent = true; child.kill(); send({ type: 'done', clientId, content: '\n⏱️ Timeout' }); resolve(); } }, 10 * 60 * 1000);
  });
}

// ─── Start ────────────────────────────────────────────────────

console.log('═══════════════════════════════════════');
console.log('  Agent Hub — Desktop Relay');
console.log('═══════════════════════════════════════');

const agents = getAvailableAgents();
console.log(`  Agents:   ${agents.length ? agents.map(a => a.name).join(', ') : 'none'}`);
console.log(`  Server:   ${SERVER_URL}`);
console.log('═══════════════════════════════════════\n');

connect();

process.on('SIGINT', () => {
  clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit(0);
});
