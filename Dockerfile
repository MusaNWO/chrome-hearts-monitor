FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY monitor.js ./

# Keep memory footprint tiny — Chromium is only loaded if Waitwhile WAF blocks HTTPS
ENV NODE_OPTIONS=--max-old-space-size=192

CMD ["node", "monitor.js"]
