const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');
let pty = null;
try { pty = require('node-pty'); } catch {}

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:3001';
const WORKSPACE_CWD = path.resolve(process.env.AGENTHUB_CWD || process.env.WORKSPACE_CWD || path.join(__dirname, '..'));
const isWin = os.platform() === 'win32';

const AGENTS = [
  { id: 'codex',    name: 'Codex',    modelKey: 'CODEX_MODEL',    cmd: process.env.CODEX_PATH || 'codex', args: p => ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', p], localPromptCli: true, jsonExec: true },
  { id: 'opencode', name: 'OpenCode', modelKey: 'OPENCODE_MODEL', cmd: null, args: p => ['run', '--dangerously-skip-permissions', '--format', 'json', p], localPromptCli: true, serverBacked: true },
];

const PTY_AGENT_ARGS = {
  codex: (prompt, sessionId) => sessionId
    ? ['resume', sessionId, prompt, '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen']
    : ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', prompt],
};

function quoteCmdArg(value) {
  const raw = String(value);
  const escaped = raw.replace(/([&|^<>()!])/g, '^$1').replace(/"/g, '""');
  return /[\s"]/u.test(raw) ? `"${escaped}"` : escaped;
}

function spawnAgentCommand(cmd, args) {
  if (!isWin) {
    return spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  }

  // Windows CLI tools installed through npm/cargo are often .cmd/.ps1 shims.
  // Running through cmd.exe avoids EPERM from child_process.spawn on those shims.
  const commandLine = [quoteCmdArg(cmd), ...args.map(quoteCmdArg)].join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
    windowsHide: true,
  });
}

function spawnCodexCommand(args) {
  const nodeLaunch = resolveCodexNodeLaunch(args);
  if (nodeLaunch) {
    return spawn(nodeLaunch.command, nodeLaunch.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      windowsHide: true,
    });
  }
  return spawnAgentCommand(process.env.CODEX_PATH || 'codex', args);
}

function buildWindowsCommandLine(cmd, args) {
  return [quoteCmdArg(cmd), ...args.map(quoteCmdArg)].join(' ');
}

function buildPtyCommand(cmd, args) {
  if (!isWin) return { command: cmd, args };
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', buildWindowsCommandLine(cmd, args)],
  };
}

function resolveCodexNodeLaunch(args) {
  if (!isWin) return null;
  const codexJs = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (!fs.existsSync(codexJs)) return null;
  return { command: process.execPath, args: [codexJs, ...args] };
}

function buildPtyAgentLaunch(agent, cmd, args) {
  if (agent === 'codex') {
    const nodeLaunch = resolveCodexNodeLaunch(args);
    if (nodeLaunch) return nodeLaunch;
  }
  return buildPtyCommand(cmd, args);
}

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

function commandExists(command) {
  if (!command) return false;
  if (path.isAbsolute(command)) {
    try { fs.accessSync(command); return true; } catch { return false; }
  }
  const pathExt = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  const names = isWin && !path.extname(command) ? pathExt.map(ext => command + ext.toLowerCase()).concat(pathExt.map(ext => command + ext)) : [command];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      try { fs.accessSync(path.join(dir, name)); return true; } catch {}
    }
  }
  return false;
}

function readCodexConfig() {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    if (!fs.existsSync(authPath)) return {};
    const cfg = {};
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const model = raw.match(/model\s*=\s*"([^"]+)"/)?.[1];
      if (model) cfg.CODEX_MODEL = model;
    }
    return cfg;
  } catch { return {}; }
}

function readOpenCodeConfig() {
  try {
    const authPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    if (!fs.existsSync(authPath)) return {};
    JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    return {};
  } catch { return {}; }
}

function readLocalConfig() {
  const cfg = { ...readCodexConfig(), ...readOpenCodeConfig() };
  cfg.LOCAL_AGENTS = getAvailableAgents().map(a => a.id);
  return cfg;
}

// ─── Detect available agents ──────────────────────────────────

function getAvailableAgents() {
  return AGENTS.filter((a) => {
    if (!a.localPromptCli) return false;
    const cmd = getCmd(a);
    if (!commandExists(cmd)) return false;
    if (a.id === 'codex') return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
    if (a.id === 'opencode') {
      const dataDir = path.join(os.homedir(), '.local', 'share', 'opencode');
      return fs.existsSync(path.join(dataDir, 'auth.json')) || fs.existsSync(path.join(dataDir, 'opencode.db'));
    }
    return false;
  });
}

// ─── WebSocket ────────────────────────────────────────────────

let ws, reconnectTimer, heartbeatTimer, sessionCode;

function connect() {
  if (ws) { ws.close(); ws = null; }
  ws = new WebSocket(SERVER_URL);

  ws.on('open', () => {
    const config = readLocalConfig();
    ws.send(JSON.stringify({ type: 'register_relay', config }));
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: 'ping' }), 25000);
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
      const { agent, prompt, clientId, sessionId } = msg;
      console.log(`\n📩 ${agent}: "${prompt.slice(0, 80)}..."`);
      await executeAgent(agent, prompt, clientId, sessionId);
    } else if (msg.type === 'session_list') {
      const sessions = await listLocalSessions(msg.agent);
      send({ type: 'sessions', clientId: msg.clientId, sessions });
    } else if (msg.type === 'session_detail') {
      try {
        const detail = msg.agent === 'opencode'
          ? await getOpenCodeSessionDetail(msg.sessionId)
          : await getCodexSessionDetail(msg.sessionId);
        send({ type: 'session_detail', clientId: msg.clientId, detail });
      } catch (err) {
        send({ type: 'error', clientId: msg.clientId, content: err.message });
      }
    } else if (msg.type === 'pong') {
      return;
    } else if (msg.type === 'system' || msg.type === 'phone_connected') {
      console.log(`ℹ️  ${msg.content || msg.type}`);
    }
  });

  ws.on('close', () => {
    clearInterval(heartbeatTimer);
    console.log('❌ Disconnected. Reconnecting in 5s...');
    ws = null;
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    clearInterval(heartbeatTimer);
    console.error(`⚠️  ${err.message}`);
    ws = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  });
}

function send(obj) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(obj));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const OPENCODE_PORT = Number(process.env.OPENCODE_PORT || 4096);
const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL || `http://127.0.0.1:${OPENCODE_PORT}`;
let opencodeServerProcess = null;

async function requestJson(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function isOpenCodeServerRunning() {
  try {
    const health = await requestJson(`${OPENCODE_BASE_URL}/global/health`);
    return !!health;
  } catch {
    return false;
  }
}

async function ensureOpenCodeServer() {
  if (await isOpenCodeServerRunning()) return;
  const opencode = AGENTS.find((a) => a.id === 'opencode');
  const cmd = opencode ? getCmd(opencode) : null;
  if (!cmd || !commandExists(cmd)) throw new Error('OpenCode CLI not found.');

  opencodeServerProcess = spawn(cmd, ['serve', '--hostname', '127.0.0.1', '--port', String(OPENCODE_PORT), '--log-level', 'ERROR'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    cwd: WORKSPACE_CWD,
    env: { ...process.env },
    windowsHide: true,
  });

  for (let i = 0; i < 30; i++) {
    if (await isOpenCodeServerRunning()) return;
    await sleep(500);
  }
  throw new Error(`OpenCode server did not start on ${OPENCODE_BASE_URL}.`);
}

function responseItems(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.value)) return json.value;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.items)) return json.items;
  return [];
}

function toOpenCodeSession(item) {
  return {
    agent: 'opencode',
    id: item.id,
    title: item.title || item.slug || item.id,
    subtitle: item.directory || item.path || 'OpenCode',
    directory: item.directory || '',
    updatedAt: item.time?.updated || item.time_updated || 0,
    createdAt: item.time?.created || item.time_created || 0,
    status: '',
    summary: item.summary || null,
  };
}

function stripTerminalNoise(value) {
  return String(value || '')
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu, '')
    .replace(/\r/g, '')
    .trim();
}

function truncateText(value, max = 140) {
  const text = stripTerminalNoise(value).replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function readJsonLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function codexSessionsRoot() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function collectJsonlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function readCodexIndexTitles() {
  const titles = new Map();
  const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return titles;
  for (const line of fs.readFileSync(indexPath, 'utf-8').split(/\r?\n/).filter(Boolean)) {
    const item = readJsonLine(line);
    if (item?.id) titles.set(item.id, item.thread_name || item.title || item.id);
  }
  return titles;
}

function extractTextParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part) return '';
    if (typeof part === 'string') return part;
    return part.text || part.message || part.output || '';
  }).filter(Boolean).join('\n');
}

function parseCodexRollout(file, includeEvents = false) {
  const stat = fs.statSync(file);
  const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/).filter(Boolean);
  const messages = [];
  const commands = [];
  const tools = [];
  const files = new Set();
  let meta = {};
  let firstUserText = '';

  for (const line of lines) {
    const ev = readJsonLine(line);
    if (!ev) continue;
    const payload = ev.payload || {};
    const time = ev.timestamp || payload.timestamp || null;

    if (ev.type === 'session_meta') {
      meta = { ...meta, ...payload };
      continue;
    }

    if (ev.type === 'response_item') {
      if (payload.type === 'message') {
        const role = payload.role || 'message';
        if (!['user', 'assistant'].includes(role)) continue;
        const text = stripTerminalNoise(extractTextParts(payload.content));
        if (text && !isHiddenCodexText(text)) {
          if (role === 'user' && !firstUserText) firstUserText = text;
          messages.push({ role, text, time, type: 'message' });
        }
      } else if (includeEvents && payload.type === 'function_call') {
        const name = payload.name || 'tool';
        const args = stripTerminalNoise(payload.arguments || '');
        if (name === 'shell_command' && args) {
          const command = extractCommandFromArgs(args);
          commands.push({ name, command: command || truncateText(args, 500), time });
        } else {
          tools.push({ name, arguments: truncateText(args, 700), time });
        }
        for (const candidate of extractPathsFromText(args)) files.add(candidate);
      } else if (includeEvents && payload.type === 'function_call_output') {
        const text = stripTerminalNoise(payload.output || '');
        for (const candidate of extractPathsFromText(text)) files.add(candidate);
      }
      continue;
    }

    if (ev.type === 'event_msg') {
      if (payload.type === 'user_message') {
        const text = stripTerminalNoise(payload.message || '');
        if (text && !firstUserText) firstUserText = text;
      } else if (payload.type === 'agent_message') {
        const text = stripTerminalNoise(payload.message || '');
        if (text && !isHiddenCodexText(text)) messages.push({ role: 'assistant', text, time, type: 'message' });
      } else if (includeEvents && /tool|exec|browser|file|patch|command/i.test(payload.type || '')) {
        const compact = truncateText(JSON.stringify(payload), 1000);
        tools.push({ name: payload.type || 'event', arguments: compact, time });
      }
    }
  }

  return {
    id: meta.id || path.basename(file, '.jsonl'),
    file,
    meta,
    firstUserText,
    messages: dedupeAdjacentMessages(messages),
    commands,
    tools,
    files: [...files],
    updatedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs || stat.ctimeMs,
  };
}

function isHiddenCodexText(text) {
  return /^Workspace:\s+/i.test(text)
    || /^<environment_context>/i.test(text)
    || text.includes('You are Codex, a coding agent')
    || text.includes('# Instructions');
}

function dedupeAdjacentMessages(messages) {
  const out = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role && prev.text === msg.text) continue;
    out.push(msg);
  }
  return out;
}

function extractCommandFromArgs(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj.command || '';
  } catch {
    return '';
  }
}

function extractPathsFromText(raw) {
  const text = String(raw || '');
  const matches = text.match(/[A-Z]:\\[^\s"',)]+|(?:\.{0,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g) || [];
  return matches.map((m) => m.replace(/\\+/g, '\\')).filter((m) => /\.[A-Za-z0-9]{1,8}$/.test(m)).slice(0, 50);
}

function getCodexRollouts(limit = 200) {
  return collectJsonlFiles(codexSessionsRoot())
    .map((file) => {
      try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((item) => item.file);
}

async function listOpenCodeSessions() {
  try {
    await ensureOpenCodeServer();
    const json = await requestJson(`${OPENCODE_BASE_URL}/session?limit=100`);
    return responseItems(json).map(toOpenCodeSession).filter((s) => s.id);
  } catch (err) {
    return [{ agent: 'opencode', id: '', title: `OpenCode unavailable: ${err.message}`, subtitle: '', updatedAt: 0, error: true }];
  }
}

function listCodexSessions() {
  const titles = readCodexIndexTitles();
  return getCodexRollouts(1000).map((file) => {
    try {
      const parsed = parseCodexRollout(file, false);
      const cwd = parsed.meta.cwd || '';
      const project = cwd ? path.basename(cwd) : 'Codex';
      const title = titles.get(parsed.id) || truncateText(parsed.firstUserText, 72) || parsed.id;
      return {
        agent: 'codex',
        id: parsed.id,
        title,
        subtitle: cwd ? `${project} - ${cwd}` : 'Codex',
        directory: cwd,
        project,
        path: file,
        updatedAt: parsed.updatedAt,
        createdAt: parsed.createdAt,
        originator: parsed.meta.originator || '',
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function listLocalSessions(agent) {
  const codexSessions = agent && agent !== 'codex' ? [] : listCodexSessions();
  const opencodeSessions = agent && agent !== 'opencode' ? [] : await listOpenCodeSessions();
  return [...codexSessions, ...opencodeSessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function formatOpenCodePart(part) {
  if (!part) return '';
  if (part.type === 'text') return part.text || '';
  if (part.type === 'tool') {
    const status = part.state?.status || '';
    const title = part.state?.title || part.tool || 'tool';
    const input = part.state?.input ? `\ninput: ${JSON.stringify(part.state.input)}` : '';
    const output = part.state?.output ? `\noutput: ${String(part.state.output).slice(0, 4000)}` : '';
    return `[tool:${title}${status ? ` ${status}` : ''}]${input}${output}`;
  }
  if (part.type === 'file') return `[file:${part.filename || part.url || 'attachment'}]`;
  return `[${part.type || 'part'}]`;
}

function formatOpenCodeMessage(message) {
  const info = message.info || message;
  const role = info.role || message.role || 'message';
  const parts = message.parts || message.content || [];
  const text = Array.isArray(parts) ? parts.map(formatOpenCodePart).filter(Boolean).join('\n') : '';
  return {
    id: info.id || message.id || '',
    role,
    text,
    time: info.time || message.time || null,
  };
}

async function getOpenCodeSessionDetail(sessionId) {
  await ensureOpenCodeServer();
  const [messagesJson, diffJson, todoJson] = await Promise.all([
    requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}/message?limit=100`).catch((err) => ({ error: err.message })),
    requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}/diff`).catch(() => []),
    requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(sessionId)}/todo`).catch(() => []),
  ]);
  return {
    agent: 'opencode',
    sessionId,
    messages: responseItems(messagesJson).map(formatOpenCodeMessage),
    diff: responseItems(diffJson),
    todo: responseItems(todoJson),
  };
}

function findCodexRollout(sessionId) {
  for (const file of getCodexRollouts(500)) {
    try {
      const parsed = parseCodexRollout(file, false);
      if (parsed.id === sessionId || path.basename(file, '.jsonl').includes(sessionId)) return file;
    } catch {}
  }
  return null;
}

async function getCodexSessionDetail(sessionId) {
  const file = findCodexRollout(sessionId);
  if (!file) throw new Error(`Codex session not found: ${sessionId}`);
  const parsed = parseCodexRollout(file, true);
  return {
    agent: 'codex',
    sessionId: parsed.id,
    title: truncateText(parsed.firstUserText, 90) || parsed.id,
    directory: parsed.meta.cwd || '',
    project: parsed.meta.cwd ? path.basename(parsed.meta.cwd) : '',
    path: file,
    updatedAt: parsed.updatedAt,
    messages: parsed.messages.slice(-300),
    files: parsed.files,
    commands: parsed.commands.slice(-50),
    tools: parsed.tools.slice(-50),
  };
}

async function createOpenCodeSession() {
  await ensureOpenCodeServer();
  const json = await requestJson(`${OPENCODE_BASE_URL}/session`, {
    method: 'POST',
    body: '{}',
  });
  return json?.value || json?.data || json;
}

async function sendOpenCodePrompt(prompt, clientId, sessionId) {
  await ensureOpenCodeServer();
  let target = sessionId;
  if (!target) {
    const created = await createOpenCodeSession();
    target = created?.id;
  }
  if (!target) throw new Error('OpenCode session not found.');

  send({ type: 'status', clientId, content: `Sending to OpenCode session ${target}` });
  await requestJson(`${OPENCODE_BASE_URL}/session/${encodeURIComponent(target)}/prompt_async`, {
    method: 'POST',
    body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
  });
  send({ type: 'status', clientId, content: `OpenCode accepted prompt for ${target}` });

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const detail = await getOpenCodeSessionDetail(target).catch(() => null);
    if (detail?.messages?.length) {
      const latest = detail.messages.slice(-6).map((m) => `${m.role}: ${m.text}`).join('\n\n');
      send({ type: 'replace_stream', clientId, content: latest });
    }
    const statusJson = await requestJson(`${OPENCODE_BASE_URL}/session/status`).catch(() => null);
    const statuses = statusJson?.value || statusJson?.data || statusJson || {};
    const current = statuses[target];
    if (!current || current.status === 'idle' || current === 'idle') break;
  }
  send({ type: 'done', clientId, content: '' });
}

function codexExecArgs(prompt, sessionId) {
  if (sessionId) {
    return ['exec', 'resume', '--json', '--dangerously-bypass-approvals-and-sandbox', sessionId, prompt];
  }
  return ['exec', '--json', '--dangerously-bypass-approvals-and-sandbox', prompt];
}

function formatCodexJsonEvent(ev) {
  const payload = ev?.payload || {};
  if (ev?.type === 'response_item') {
    if (payload.type === 'message') {
      const role = payload.role || 'assistant';
      const text = stripTerminalNoise(extractTextParts(payload.content));
      if (!text || isHiddenCodexText(text)) return null;
      return role === 'assistant' ? { kind: 'stream', text } : null;
    }
    if (payload.type === 'function_call') {
      const name = payload.name || 'tool';
      const command = name === 'shell_command' ? extractCommandFromArgs(payload.arguments || '') : '';
      return { kind: 'status', text: command ? `command: ${command}` : `tool: ${name}` };
    }
    if (payload.type === 'function_call_output') {
      const text = stripTerminalNoise(payload.output || '');
      return text ? { kind: 'status', text: truncateText(text, 900) } : null;
    }
  }
  if (ev?.type === 'event_msg') {
    if (payload.type === 'agent_message') {
      const text = stripTerminalNoise(payload.message || '');
      return text && !isHiddenCodexText(text) ? { kind: 'stream', text } : null;
    }
    if (payload.type === 'task_started') return { kind: 'status', text: 'Codex started' };
    if (payload.type === 'task_complete') return { kind: 'status', text: 'Codex finished' };
  }
  return null;
}

async function sendCodexPrompt(prompt, clientId, sessionId) {
  if (!sessionId) {
    throw new Error('Pick a Codex chat first. This build blocks accidental new Codex sessions from the phone.');
  }

  const a = AGENTS.find((x) => x.id === 'codex');
  const cmd = getCmd(a);
  if (!commandExists(cmd)) throw new Error('Codex CLI not found on PATH.');
  const args = codexExecArgs(prompt, sessionId);
  console.log(`  [codex-json] resume ${sessionId}`);
  const before = await getCodexSessionDetail(sessionId).catch(() => null);
  const beforeCount = before?.messages?.length || 0;
  send({ type: 'status', clientId, content: `Sending to Codex chat ${sessionId}` });
  send({ type: 'status', clientId, content: 'Codex is running via resume; it will not type into the visible desktop composer.' });

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnCodexCommand(args);
    } catch (err) {
      reject(err);
      return;
    }

    let buffer = '';
    let fullText = '';
    let done = false;
    let sawEvent = false;
    let firstEventTimer = null;

    function consume(data) {
      const text = data.toString();
      fullText += text;
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const ev = readJsonLine(line);
        if (!ev) continue;
        sawEvent = true;
        if (firstEventTimer) {
          clearTimeout(firstEventTimer);
          firstEventTimer = null;
        }
        const formatted = formatCodexJsonEvent(ev);
        if (!formatted) continue;
        if (formatted.kind === 'stream') send({ type: 'replace_stream', clientId, content: formatted.text });
        else send({ type: 'status', clientId, content: formatted.text });
      }
    }

    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', reject);
    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (code === 0) resolve();
      else reject(new Error(stripTerminalNoise(fullText).slice(-1200) || `Codex exited ${code}`));
    });

    firstEventTimer = setTimeout(() => {
      if (done || sawEvent) return;
      done = true;
      try { child.kill(); } catch {}
      reject(new Error('Codex did not emit any resume events in 45 seconds. This usually means that chat is currently active/locked in Codex Desktop; pick an inactive chat or start a dedicated phone chat.'));
    }, 45 * 1000);

    setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      reject(new Error('Codex timed out after 3 minutes.'));
    }, 3 * 60 * 1000);
  });

  const detail = await getCodexSessionDetail(sessionId).catch(() => null);
  if (detail) send({ type: 'session_detail', clientId, detail });
  if (detail && (detail.messages?.length || 0) <= beforeCount) {
    send({ type: 'status', clientId, content: 'Codex finished but no new assistant message appeared in the session log.' });
  }
  send({ type: 'done', clientId, content: '' });
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
    console.log('⚠️  No agents detected.');
    console.log('   Install and sign in to Codex or OpenCode.\n');
  }

  try {
    if (fileContent) fs.writeFileSync(qrFile, fileContent);
  } catch {}
}

// ─── Agent execution ──────────────────────────────────────────

const ptySessions = new Map();

function sessionKey(agent, sessionId = '') {
  return `${agent}:${WORKSPACE_CWD}:${sessionId || 'default'}`;
}

function startPtyAgent(agent, prompt, clientId, sessionId = '') {
  if (!pty) throw new Error('node-pty is not installed. Run npm install in backend/.');
  const a = AGENTS.find(x => x.id === agent);
  if (!a) throw new Error(`Unknown agent: ${agent}`);
  if (!a.localPromptCli) throw new Error(`${a.name} is installed as an editor launcher, not a promptable local agent CLI.`);
  if (a.serverBacked) throw new Error(`${a.name} uses its local HTTP server, not PTY.`);

  const cmd = getCmd(a);
  if (!commandExists(cmd)) throw new Error(`${a.name} CLI not found on PATH.`);
  const args = (PTY_AGENT_ARGS[agent] || ((p) => a.args(p)))(prompt, sessionId);
  const launch = buildPtyAgentLaunch(agent, cmd, args);
  const id = sessionKey(agent, sessionId);
  console.log(`  [pty] ${a.name} cwd=${WORKSPACE_CWD}`);
  console.log(`  [pty] $ ${launch.command} ${launch.args.join(' ')}`);

  const terminal = pty.spawn(launch.command, launch.args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: WORKSPACE_CWD,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      NO_COLOR: '0',
    },
  });

  const session = {
    id,
    agent,
    name: a.name,
    terminal,
    clients: new Set([clientId]),
    output: '',
    closed: false,
  };
  ptySessions.set(id, session);

  terminal.onData((data) => {
    session.output = (session.output + data).slice(-256 * 1024);
    process.stdout.write(data);
    for (const target of session.clients) {
      send({ type: 'stream', clientId: target, content: data });
    }
  });

  terminal.onExit(({ exitCode }) => {
    session.closed = true;
    ptySessions.delete(id);
    for (const target of session.clients) {
      send({ type: 'done', clientId: target, content: `\n[${a.name} exited ${exitCode}]\n` });
    }
  });

  return session;
}

function executePtyAgent(agent, prompt, clientId, sessionId = '') {
  const id = sessionKey(agent, sessionId);
  let session = ptySessions.get(id);
  if (!session || session.closed) {
    const target = sessionId ? ` session ${sessionId}` : '';
    send({ type: 'status', clientId, content: `Starting ${agent}${target} in ${WORKSPACE_CWD}` });
    startPtyAgent(agent, prompt, clientId, sessionId);
    return;
  }

  session.clients.add(clientId);
  send({ type: 'status', clientId, content: `Sending to existing ${agent} session in ${WORKSPACE_CWD}` });
  if (session.output) {
    send({ type: 'stream', clientId, content: session.output.slice(-12000) });
  }
  session.terminal.write(prompt);
  setTimeout(() => {
    try { session.terminal.write('\r'); } catch {}
  }, 250);
}

function executeAgent(agent, prompt, clientId, sessionId = '') {
  return new Promise(async (resolve) => {
    const a = AGENTS.find(x => x.id === agent);
    if (!a) { send({ type: 'error', clientId, content: `Unknown agent: ${agent}` }); resolve(); return; }
    if (!a.localPromptCli) { send({ type: 'error', clientId, content: `${a.name} is installed as an editor launcher, not a promptable local agent CLI.` }); resolve(); return; }
    if (a.serverBacked) {
      try {
        await sendOpenCodePrompt(prompt, clientId, sessionId);
      } catch (err) {
        send({ type: 'error', clientId, content: `OpenCode failed: ${err.message}` });
      }
      resolve();
      return;
    }

    if (agent === 'codex') {
      try {
        await sendCodexPrompt(prompt, clientId, sessionId);
      } catch (err) {
        send({ type: 'error', clientId, content: `Codex failed: ${err.message}` });
      }
      resolve();
      return;
    }

    if (process.env.AGENTHUB_ONE_SHOT !== '1') {
      try {
        executePtyAgent(agent, prompt, clientId, sessionId);
      } catch (err) {
        send({ type: 'error', clientId, content: `PTY failed: ${err.message}` });
      }
      resolve();
      return;
    }

    const cmd = getCmd(a);
    const args = a.args(prompt);
    console.log(`  $ ${cmd} ${args.join(' ')}`);
    send({ type: 'status', clientId, content: `🔄 ${a.name}...` });

    let child;
    try {
      child = spawnAgentCommand(cmd, args);
    } catch (err) {
      send({ type: 'error', clientId, content: `Failed to start ${a.name}: ${err.message}` });
      resolve();
      return;
    }
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
        send({ type: 'stream', clientId, content: text });
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
console.log(`  Cwd:      ${WORKSPACE_CWD}`);
console.log(`  Mode:     Codex JSON resume + OpenCode session server${pty ? ' + PTY fallback' : ''}`);
console.log('═══════════════════════════════════════\n');

connect();

process.on('SIGINT', () => {
  clearTimeout(reconnectTimer);
  clearInterval(heartbeatTimer);
  for (const session of ptySessions.values()) {
    try { session.terminal.kill(); } catch {}
  }
  try { opencodeServerProcess?.kill(); } catch {}
  if (ws) ws.close();
  process.exit(0);
});
