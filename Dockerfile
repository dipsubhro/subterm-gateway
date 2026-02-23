FROM node:20-bullseye-slim

# Enable corepack for pnpm
RUN corepack enable

WORKDIR /app

# Copy package files and install production deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy source
COPY index.js timeout.js ./

# Non-root user
RUN useradd -m appuser \
  && chown -R appuser:appuser /app
USER appuser

ENV PORT=4500 \
    NODE_ENV=production

EXPOSE 4500

CMD ["node", "index.js"]
