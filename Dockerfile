#backend/Dockerfile
FROM node:20-alpine

WORKDIR /app

# install deps
COPY package*.json ./
RUN npm ci --omit=dev

# copy source
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]