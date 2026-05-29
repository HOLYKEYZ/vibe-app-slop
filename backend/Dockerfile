FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json server.ts relay.ts ./
RUN npm run build && npm prune --production

EXPOSE 3001
CMD ["node", "dist/server.js"]
