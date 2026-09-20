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

# Install python, make, g++ for sqlite3 building from source
RUN apk add --no-cache python3 make g++

# Install backend dependencies
COPY backend/package*.json ./
RUN npm ci

# Copy backend source
COPY backend/ ./

# Create public directory if it doesn't exist, and copy built frontend
RUN mkdir -p public
COPY --from=frontend-builder /app/frontend/dist ./public/

# Expose the backend port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]
