# syntax = docker/dockerfile:1

ARG NODE_VERSION=24.11.1
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Remix/Prisma"

# App folder
WORKDIR /app

# Production environment
ENV NODE_ENV=production
ENV PORT=3000

# Install build dependencies
FROM base AS build
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp openssl pkg-config python-is-python3

# Install node modules
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Generate Prisma client
COPY prisma ./prisma
RUN npx prisma generate

# Copy source code
COPY . .

# Build Remix app
RUN npm run build

# Remove dev dependencies to reduce image size
RUN npm prune --omit=dev

# Final image
FROM base

# Install runtime dependencies
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y openssl && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Copy built app from build stage
COPY --from=build /app /app

# Expose port
EXPOSE 3000

# Start Remix server
CMD ["npm", "run", "start"]
