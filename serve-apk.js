const http = require('http');
const fs = require('fs');
const path = require('path');

const APK_PATH = path.join(__dirname, 'AgentHub', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const PORT = 8080;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/download') {
    res.writeHead(200, {
      'Content-Type': 'text/html'
    });
    res.end(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Agent Hub - Download</title>
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { 
            font-family: -apple-system, sans-serif; 
            background: #0a0a0f; 
            color: white; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            min-height: 100vh;
            padding: 20px;
          }
          .card {
            background: linear-gradient(135deg, #1a1a2e, #16213e);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 20px;
            padding: 40px 30px;
            text-align: center;
            max-width: 400px;
            width: 100%;
          }
          .icon { font-size: 64px; margin-bottom: 16px; }
          h1 { font-size: 28px; margin-bottom: 8px; }
          p { color: #888; margin-bottom: 24px; font-size: 14px; }
          .btn {
            display: inline-block;
            background: linear-gradient(135deg, #8B5CF6, #6D28D9);
            color: white;
            text-decoration: none;
            padding: 16px 40px;
            border-radius: 12px;
            font-size: 18px;
            font-weight: 600;
            transition: transform 0.2s;
          }
          .btn:active { transform: scale(0.95); }
          .hint { color: #555; font-size: 12px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon">🤖</div>
          <h1>Agent Hub</h1>
          <p>Your universal AI agent controller.<br>Antigravity · Codex · OpenCode · Windsurf · Kiro</p>
          <a href="/apk" class="btn">⬇ Install APK</a>
          <p class="hint">After downloading, open the file and tap "Install".<br>You may need to allow "Install from unknown sources".</p>
        </div>
      </body>
      </html>
    `);
  } else if (req.url === '/apk') {
    const stat = fs.statSync(APK_PATH);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="AgentHub.apk"',
      'Content-Length': stat.size
    });
    fs.createReadStream(APK_PATH).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\\n========================================`);
  console.log(`  APK Download Server Running!`);
  console.log(`  Open this on your phone:`);
  console.log(`  http://192.168.100.13:${PORT}`);
  console.log(`========================================\\n`);
});
