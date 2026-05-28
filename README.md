# codex-OC_mobile

Remote control Codex and OpenCode from your phone through a desktop relay.

```text
Phone --wss--> Relay Server <--wss-- Laptop relay
                                      |-- Codex local session
                                      `-- OpenCode local server
```

- Relay-only execution: the server never calls model APIs.
- QR pairing: scan the laptop relay code from the Android app.
- Session-aware control: list local Codex/OpenCode chats and send prompts into a selected session.
- Offline behavior: if the laptop relay is offline, the phone receives an offline error.

## Quick Start

### 1. Deploy the server

```bash
git clone https://github.com/HOLYKEYZ/vibe-app-slop.git
cd vibe-app-slop/backend
npm install
node server.js
```

Deploy `backend/` on Render as a Node.js web service. Port `3001`.

### 2. Install Android app

```bash
cd AgentHub
./gradlew assembleDebug
```

The APK is written to `AgentHub/app/build/outputs/apk/debug/app-debug.apk`.

### 3. Start the laptop relay

```bash
cd backend
npm install
SERVER_URL=wss://your-server.onrender.com node relay.js
```

The relay checks for signed-in local Codex/OpenCode installs and prints a QR code. Secrets stay on the laptop.

### 4. Connect your phone

Open Agent Hub, scan the QR code, pick a visible chat, and send a prompt.

## Agents

| Agent | How it is driven |
|-------|------------------|
| Codex | Local Codex CLI session or `codex resume <session>` |
| OpenCode | Local `opencode serve` HTTP API on `127.0.0.1:4096` |

## Environment

| Env | Default | Description |
|-----|---------|-------------|
| `PORT` | `3001` | Relay server port |
| `SERVER_URL` | `ws://localhost:3001` | Relay server URL used by `relay.js` |
| `AGENTHUB_CWD` | repo root | Working directory for local agents |
| `OPENCODE_PORT` | `4096` | Local OpenCode server port |
