# Brave MCP Server — Dockerfile with integrated Webclaw L3 side-car
#
# Architecture:
#   Stage 1 (webclaw-builder): builds the Rust Webclaw server from source.
#     ~5-10 min, BoringSSL is heavy. Output: ~26 MB webclaw-server binary.
#   Stage 2 (final): Node.js + Brave Browser + Webclaw binary.
#     Runtime: docker-entrypoint.sh starts webclaw-server on 127.0.0.1:3001
#     in the background, then exec npm run http for the main MCP server on
#     port 3000. brave-controller.js calls Webclaw via WEBCLAW_URL.

# ════════════════════════════════════════════════════════════════════
# Stage 1: Webclaw Rust builder
# ════════════════════════════════════════════════════════════════════
FROM rust:1.95-slim-bookworm AS webclaw-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    pkg-config \
    libssl-dev \
    cmake \
    clang \
    libclang-dev \
    build-essential \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone --depth 1 https://github.com/0xMassi/webclaw.git
WORKDIR /build/webclaw
RUN cargo build --release --bin webclaw-server

# ════════════════════════════════════════════════════════════════════
# Stage 2: Final image — Node.js + Brave + Webclaw side-car
# ════════════════════════════════════════════════════════════════════
FROM node:18-slim

# Chromium / Brave dependencies + curl for healthcheck and entrypoint readiness probe
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    gnupg \
    ca-certificates \
    procps \
    curl \
    libxss1 \
    libgconf-2-4 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libatk1.0-0 \
    libcairo-gobject2 \
    libgtk-3-0 \
    libgdk-pixbuf2.0-0 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxtst6 \
    libdrm2 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libx11-6 \
    libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# Install Brave Browser (Puppeteer launcher)
RUN wget -q -O - https://brave-browser-apt-release.s3.brave.com/brave-core.asc | apt-key add - \
    && echo "deb [arch=amd64] https://brave-browser-apt-release.s3.brave.com/ stable main" > /etc/apt/sources.list.d/brave-browser-release.list \
    && apt-get update \
    && apt-get install -y brave-browser \
    && rm -rf /var/lib/apt/lists/*

# Webclaw binary from stage 1 (~26 MB)
COPY --from=webclaw-builder /build/webclaw/target/release/webclaw-server /usr/local/bin/webclaw-server
RUN chmod +x /usr/local/bin/webclaw-server

# App
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

# docker-entrypoint launches Webclaw + node
RUN chmod +x /app/docker-entrypoint.sh

# Non-root user (Puppeteer best practice)
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser \
    && chown -R pptruser:pptruser /app
USER pptruser

EXPOSE 3000

ENV HEADLESS=true
ENV BRAVE_PATH=/usr/bin/brave-browser
ENV HTTP_PORT=3000
ENV NODE_ENV=production
# Webclaw L3 side-car (localhost-only, internal)
ENV WEBCLAW_URL=http://127.0.0.1:3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

CMD ["/app/docker-entrypoint.sh"]
