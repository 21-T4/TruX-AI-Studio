# Builds the current TruX Studio app (./trux-studio). The older single-file app in the repo root is no longer deployed.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY trux-studio/package*.json ./
RUN npm install --omit=dev
COPY trux-studio/ .
# Load the public Firebase web config at startup (server.js also has the same defaults as a safety net).
RUN if [ -f .env.example ] && [ ! -f .env ]; then cp .env.example .env; fi
USER node
EXPOSE 8080
CMD ["node", "--env-file-if-exists=.env", "server.js"]
