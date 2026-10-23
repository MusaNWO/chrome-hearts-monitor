FROM node:20-bookworm

WORKDIR /app

# Chromium system deps + virtual display for HEADED captcha on Railway
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xauth \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium

COPY monitor-v2.js book.js ./
COPY lib ./lib

ENV NODE_OPTIONS=--max-old-space-size=768
ENV HEADED=1
ENV DRY_RUN=0

# xvfb so Playwright can run headed (required for Waitwhile reCAPTCHA)
CMD ["sh", "-c", "exec xvfb-run -a stdbuf -oL -eL node monitor-v2.js"]
