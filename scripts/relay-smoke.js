#!/usr/bin/env node
const path = require('path');

let WebSocket;
try {
  WebSocket = require(path.join(__dirname, '..', 'backend', 'node_modules', 'ws'));
} catch {
  WebSocket = require('ws');
}

const serverUrl = process.env.SERVER_URL || process.argv[2] || 'wss://agent-hub-backend-wk48.onrender.com';
const relayCode = process.env.RELAY_CODE || process.argv[3] || '';
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS || 45000);

if (!relayCode) {
  console.error('Usage: node scripts/relay-smoke.js <server-url> <relay-code>');
  console.error('Or set SERVER_URL and RELAY_CODE.');
  process.exit(2);
}

function withTimeout(label, work) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    work().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function connectPhone(label) {
  return withTimeout(label, () => new Promise((resolve, reject) => {
    const ws = new WebSocket(serverUrl);
    const state = { joined: null, sessions: null, codexDetail: null, opencodeSessions: null };

    function send(payload) {
      ws.send(JSON.stringify(payload));
    }

    ws.on('open', () => send({ type: 'join_session', code: relayCode }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'error') {
        reject(new Error(msg.content || 'Relay returned error'));
        try { ws.close(); } catch {}
        return;
      }

      if (msg.type === 'session_joined') {
        state.joined = msg;
        if (!msg.relay_online) {
          reject(new Error('Relay is offline for this code'));
          try { ws.close(); } catch {}
          return;
        }
        send({ type: 'session_list' });
        return;
      }

      if (msg.type === 'sessions' && !state.sessions) {
        state.sessions = msg.sessions || [];
        const codex = state.sessions.find((session) => session.agent === 'codex' && session.id);
        if (!codex) {
          reject(new Error('No Codex sessions returned'));
          try { ws.close(); } catch {}
          return;
        }
        send({ type: 'session_detail', agent: 'codex', sessionId: codex.id });
        return;
      }

      if (msg.type === 'session_detail' && msg.detail?.agent === 'codex' && !state.codexDetail) {
        state.codexDetail = msg.detail;
        send({ type: 'session_list', agent: 'opencode' });
        return;
      }

      if (msg.type === 'sessions' && state.sessions && !state.opencodeSessions) {
        state.opencodeSessions = msg.sessions || [];
        try { ws.close(1000, 'smoke done'); } catch {}
        resolve(state);
      }
    });
  }));
}

function summarize(result) {
  const sessions = result.sessions || [];
  const counts = sessions.reduce((acc, session) => {
    acc[session.agent] = (acc[session.agent] || 0) + 1;
    return acc;
  }, {});
  const detail = result.codexDetail || {};
  return {
    relayOnline: !!result.joined?.relay_online,
    agents: result.joined?.available_agents || [],
    totalSessions: sessions.length,
    counts,
    opencodeSessions: result.opencodeSessions?.length || 0,
    codexDetail: {
      status: detail.status || '',
      messages: Array.isArray(detail.messages) ? detail.messages.length : 0,
      metadataScope: detail.metadataScope || '',
      commands: Array.isArray(detail.commands) ? detail.commands.length : 0,
      tools: Array.isArray(detail.tools) ? detail.tools.length : 0,
      files: Array.isArray(detail.files) ? detail.files.length : 0,
    },
  };
}

(async () => {
  const first = await connectPhone('first phone connection');
  const second = await connectPhone('reconnected phone connection');
  const firstSummary = summarize(first);
  const secondSummary = summarize(second);

  const failures = [];
  for (const [label, summary] of [['first', firstSummary], ['reconnect', secondSummary]]) {
    if (!summary.relayOnline) failures.push(`${label}: relay not online`);
    if (!summary.agents.includes('codex')) failures.push(`${label}: codex missing`);
    if (!summary.agents.includes('opencode')) failures.push(`${label}: opencode missing`);
    if (summary.totalSessions < 1) failures.push(`${label}: no sessions returned`);
    if ((summary.counts.codex || 0) < 1) failures.push(`${label}: no Codex sessions`);
    if (summary.opencodeSessions < 1) failures.push(`${label}: no OpenCode sessions`);
    if (summary.codexDetail.messages < 1) failures.push(`${label}: Codex detail has no messages`);
    if (summary.codexDetail.metadataScope !== 'latest_turn') failures.push(`${label}: Codex metadata is not latest_turn`);
  }

  console.log(JSON.stringify({ serverUrl, relayCode, first: firstSummary, reconnect: secondSummary }, null, 2));
  if (failures.length) {
    console.error(`Relay smoke failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
