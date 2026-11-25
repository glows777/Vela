FROM docker.io/library/node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep fd-find \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global bun@1.4.2 \
 && rg --version && fd --version && git --version && node --version && bun --version
USER node
WORKDIR /workspace
