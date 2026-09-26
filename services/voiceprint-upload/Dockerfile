FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY broker.mjs server.mjs ./
USER node
CMD ["node", "server.mjs"]
