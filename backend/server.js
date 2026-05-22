const http = require('http');
const { WebSocketServer } = require('ws');
const https = require('https');

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Agent Hub Backend v1.0');
});

const wss = new WebSocketServer({ server });
const clientConfigs = new Map();

wss.on('connection', (ws) => {
  const clientId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  clientConfigs.set(clientId, {});
  console.log(`[${clientId}] Client connected`);

  ws.send(JSON.stringify({ type: 'system', content: '⚡ Connected to Agent Hub Backend' }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', content: 'Invalid JSON' }));
      return;
    }

    if (msg.type === 'config') {
      clientConfigs.set(clientId, msg.config || {});
      console.log(`[${clientId}] Received config updates`);
      ws.send(JSON.stringify({ type: 'system', content: '✅ Configuration saved on backend.' }));
      return;
    }

    const { agent, prompt } = msg;
    if (!agent || !prompt) {
      ws.send(JSON.stringify({ type: 'error', content: 'Missing agent or prompt' }));
      return;
    }

    console.log(`[${clientId}] ${agent} ← "${prompt.slice(0, 80)}"`);

    try {
      if (agent.toLowerCase() === 'codex') {
        await runCodex(ws, clientId, prompt);
      } else if (agent.toLowerCase() === 'antigravity') {
        await runAntigravity(ws, clientId, prompt);
      } else {
        ws.send(JSON.stringify({ type: 'stream', content: `[Mock] Processing prompt for ${agent}...\n` }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'done', content: `\n✅ ${agent} session complete.` }));
        }, 1000);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', content: `Error: ${e.message}` }));
    }
  });

  ws.on('close', () => {
    console.log(`[${clientId}] Client disconnected`);
    clientConfigs.delete(clientId);
  });
});

async function runCodex(ws, clientId, prompt) {
  const config = clientConfigs.get(clientId) || {};
  const token = config.CHATGPT_ACCESS_TOKEN;
  if (!token) {
    ws.send(JSON.stringify({ type: 'error', content: 'CHATGPT_ACCESS_TOKEN is missing in settings.' }));
    return;
  }

  ws.send(JSON.stringify({ type: 'status', content: '🔄 Starting ChatGPT session...' }));

  const body = JSON.stringify({
    action: "next",
    messages: [{
      id: require('crypto').randomUUID(),
      author: { role: "user" },
      content: { content_type: "text", parts: [prompt] }
    }],
    model: "text-davinci-002-render-sha",
    timezone_offset_min: -120
  });

  try {
    const response = await fetch('https://chatgpt.com/backend-api/conversation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      body: body
    });

    if (!response.ok) {
      ws.send(JSON.stringify({ type: 'error', content: `ChatGPT API error: ${response.status}` }));
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          try {
            const parsed = JSON.parse(line.slice(6));
            if (parsed.message?.content?.parts?.[0]) {
               ws.send(JSON.stringify({ type: 'replace_stream', content: parsed.message.content.parts[0] }));
            }
          } catch {}
        }
      }
    }
    ws.send(JSON.stringify({ type: 'done', content: `\n✅ ChatGPT session complete.` }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', content: `Codex error: ${err.message}` }));
  }
}

async function runAntigravity(ws, clientId, prompt) {
  const config = clientConfigs.get(clientId) || {};
  const cookie = config.GEMINI_COOKIE_1PSID;
  const cookieTS = config.GEMINI_COOKIE_1PSIDTS || '';
  if (!cookie) {
    ws.send(JSON.stringify({ type: 'error', content: 'GEMINI_COOKIE_1PSID is missing in settings.' }));
    return;
  }

  ws.send(JSON.stringify({ type: 'status', content: '🔄 Fetching Gemini SNlM0e token...' }));

  try {
    const headers = {
      'Cookie': `__Secure-1PSID=${cookie}; __Secure-1PSIDTS=${cookieTS}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };

    const appRes = await fetch('https://gemini.google.com/app', { headers });
    const appText = await appRes.text();
    const match = appText.match(/"SNlM0e":"([^"]+)"/);
    if (!match) {
      ws.send(JSON.stringify({ type: 'error', content: 'Could not find SNlM0e token. Cookie might be invalid.' }));
      return;
    }
    const snlm0e = match[1];

    ws.send(JSON.stringify({ type: 'status', content: '🔄 Sending Gemini prompt...' }));

    const fReqData = [null, JSON.stringify([[prompt], null, ["", "", ""]])];
    const params = new URLSearchParams();
    params.append('f.req', JSON.stringify(fReqData));
    params.append('at', snlm0e);

    const res = await fetch('https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
      },
      body: params
    });

    if (!res.ok) {
      ws.send(JSON.stringify({ type: 'error', content: `Gemini API error: ${res.status}` }));
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        try {
          if (line.includes('wrb.fr')) {
             const parsed = JSON.parse(line);
             if (parsed[0] === 'wrb.fr' && parsed[2]) {
                 const inner = JSON.parse(parsed[2]);
                 if (inner && inner[4] && inner[4][0] && inner[4][0][1] && inner[4][0][1][0]) {
                     const text = inner[4][0][1][0];
                     ws.send(JSON.stringify({ type: 'replace_stream', content: text }));
                 }
             }
          }
        } catch (e) {}
      }
    }

    ws.send(JSON.stringify({ type: 'done', content: `\n✅ Antigravity session complete.` }));
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', content: `Antigravity error: ${err.message}` }));
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Agent Hub Backend Running on Port ${PORT}`);
});
