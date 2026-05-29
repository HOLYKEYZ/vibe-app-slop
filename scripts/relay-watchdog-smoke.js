#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'backend');
const port = Number(process.env.WATCHDOG_SMOKE_PORT || 4123);
const code = process.env.WATCHDOG_SMOKE_CODE || 'WATCHDOG1';
const timeoutMs = Number(process.env.WATCHDOG_SMOKE_TIMEOUT_MS || 90000);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-watchdog-'));
const sessionsFile = path.join(tmpDir, 'sessions.json');

const children = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startNode(script, env) {
  const child = spawn(process.execPath, [script], {
    cwd: backendDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  children.push(child);
  return child;
}

function stop(child) {
  if (!child || child.killed) return;
  try { child.kill(); } catch {}
}

async function waitForOnline(label, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/connect?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json.relayOnline === true) return { label, relayOnline: true, createdAt: json.createdAt };
      }
    } catch {}
    await delay(1000);
  }
  throw new Error(`${label} did not report relayOnline within ${seconds}s`);
}

async function main() {
  let server = startNode(path.join('dist', 'server.js'), { PORT: String(port), AGENTHUB_SESSIONS_FILE: sessionsFile });
  await delay(1500);
  const relay = startNode(path.join('dist', 'relay.js'), {
    SERVER_URL: `ws://127.0.0.1:${port}`,
    AGENTHUB_RELAY_CODE: code,
    AGENTHUB_OPEN_CODEX_DESKTOP: '0',
  });

  const first = await waitForOnline('initial', 45);
  stop(server);
  await delay(4000);
  server = startNode(path.join('dist', 'server.js'), { PORT: String(port), AGENTHUB_SESSIONS_FILE: sessionsFile });
  const second = await waitForOnline('after_backend_restart', Math.ceil(timeoutMs / 1000));

  console.log(JSON.stringify({ passed: true, code, port, first, second }, null, 2));
  stop(relay);
  stop(server);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
}).finally(() => {
  for (const child of children) stop(child);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
