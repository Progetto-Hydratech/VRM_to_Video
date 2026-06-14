FROM node:20-slim

# Install Chromium, ffmpeg and dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    ffmpeg \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY screenshotter.js ./

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "screenshotter.js"]
