FROM node:20-bookworm

WORKDIR /app

# Chromium system deps + virtual display for HEADED captcha on Railway
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    x11-utils \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium

COPY monitor-v2.js book.js docker-entrypoint.sh ./
COPY lib ./lib
RUN chmod +x docker-entrypoint.sh

ENV NODE_OPTIONS=--max-old-space-size=768
ENV HEADED=1
ENV DRY_RUN=0
ENV DISPLAY=:99

CMD ["./docker-entrypoint.sh"]
