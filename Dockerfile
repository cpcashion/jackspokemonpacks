FROM node:20-slim

# Install libvips for sharp image processing (used for DNG/HEIC conversion)
RUN apt-get update && apt-get install -y \
    libvips-dev \
    imagemagick \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Create data directory for SQLite (Railway will mount a volume here)
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server.js"]
