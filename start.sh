#!/bin/bash

# Function to clean up background processes on exit
cleanup() {
    echo "Stopping services..."
    kill $BACKEND_PID $FRONTEND_PID $LISTENER_PID 2>/dev/null
    exit
}

# Set trap to call cleanup function on script exit (like Ctrl+C)
trap cleanup SIGINT SIGTERM EXIT

# Ensure gnmic binary is available for gNMI dial-in helper
if [ ! -f backend/bin/gnmic ]; then
    if [ -f /home/chillrend/gnmic ]; then
        mkdir -p backend/bin
        cp /home/chillrend/gnmic backend/bin/gnmic
        chmod +x backend/bin/gnmic
    elif command -v gnmic &> /dev/null; then
        mkdir -p backend/bin
        cp "$(which gnmic)" backend/bin/gnmic
        chmod +x backend/bin/gnmic
    fi
fi

# Spin up background dependencies (postgres, redis, influxdb) if docker is available
if command -v docker &> /dev/null; then
    echo "Starting database and queue services in Docker (postgres, redis, influxdb)..."
    if docker compose version &> /dev/null; then
        docker compose up -d postgres redis influxdb
    elif command -v docker-compose &> /dev/null; then
        docker-compose up -d postgres redis influxdb
    fi

    # Wait for postgres to be ready
    echo "Waiting for PostgreSQL to be ready..."
    for i in {1..20}; do
        if docker exec ruijie-postgres pg_isready -U ruijie &> /dev/null; then
            echo "PostgreSQL is ready!"
            break
        fi
        sleep 0.5
    done
else
    echo "Docker not detected in PATH. Running with SQLite and in-memory queue fallback."
fi

echo "Starting backend..."
npm run dev --prefix backend &
BACKEND_PID=$!

echo "Starting gRPC telemetry listener (port 50051)..."
npm run listener --prefix backend &
LISTENER_PID=$!

echo "Starting frontend..."
npm run dev --prefix frontend -- --host 0.0.0.0 &
FRONTEND_PID=$!

echo "All services (backend, gRPC listener, frontend) are running. Press Ctrl+C to stop."

# Wait for background processes
wait
