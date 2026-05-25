FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY monitor.js ./

CMD ["node", "monitor.js"]
