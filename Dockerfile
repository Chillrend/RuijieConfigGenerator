# Stage 1: Build the frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Build the backend and serve
FROM node:20-alpine
WORKDIR /app/backend

# Install python, make, g++, curl, bash for native modules & tools
RUN apk add --no-cache python3 make g++ curl bash

# Install gnmic binary
RUN curl -sL https://raw.githubusercontent.com/openconfig/gnmic/master/install.sh | bash

# Install backend dependencies
COPY backend/package*.json ./
RUN npm ci

# Copy backend source
COPY backend/ ./

# Create public directory and copy built frontend
RUN mkdir -p public
COPY --from=frontend-builder /app/frontend/dist ./public/

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose HTTP/WebSocket API (3001) and gRPC Dial-Out Telemetry Listener (50051)
EXPOSE 3001 50051

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD []
