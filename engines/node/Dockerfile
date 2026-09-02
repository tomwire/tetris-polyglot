# Node.js Tetris Engine — Production image (multi-stage)
FROM node:22-slim AS build
WORKDIR /app

# Install ALL dependencies for build (TypeScript is in devDependencies).
# package-lock.json is intentionally gitignored, so use `npm install` (not `npm ci`).
COPY package*.json ./
RUN npm install --include=dev

COPY tsconfig.json .
COPY src/ ./src/
RUN npx tsc -p tsconfig.json

# Production runtime — only production deps + compiled JS
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
EXPOSE 8000
# Scores persist here via a compose-named volume so they survive container recreate.
RUN mkdir -p /app/data
VOLUME ["/app/data"]
CMD ["node", "dist/main.js"]
