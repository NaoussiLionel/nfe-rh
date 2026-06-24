FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=optional 2>/dev/null || npm install
COPY . .
ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]