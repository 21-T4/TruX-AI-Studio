FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
USER node
EXPOSE 8080
CMD ["node", "--env-file-if-exists=.env", "server.js"]
