# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Native deps (bcrypt) compile from source on Alpine when no musl prebuilt is
# available — node-gyp needs python3 + a C/C++ toolchain. Builder-stage only, so
# the runtime image stays slim (the compiled .node is copied via node_modules).
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --only=production

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Ensure upload dirs exist and are writable
RUN mkdir -p uploads/cv_uploads uploads/temp \
    && chown -R appuser:appgroup /app

USER appuser

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080
CMD ["node", "src/server.js"]
