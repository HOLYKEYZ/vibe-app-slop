FROM node:20-slim

# Install system deps
RUN apt-get update && apt-get install -y curl unzip git ca-certificates && rm -rf /var/lib/apt/lists/*

# Install Codex CLI globally
RUN npm install -g @openai/codex

# Install OpenCode binary
RUN curl -fsSL https://get.opencode.ai | sh || true

# Create app directory
WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]
