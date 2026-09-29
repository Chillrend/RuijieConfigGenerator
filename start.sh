#!/bin/bash

# Function to clean up background processes on exit
cleanup() {
    echo "Stopping services..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit
}

# Set trap to call cleanup function on script exit (like Ctrl+C)
trap cleanup SIGINT SIGTERM EXIT

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

echo "Starting frontend..."
npm run dev --prefix frontend -- --host 0.0.0.0 &
FRONTEND_PID=$!

echo "Both services are running. Press Ctrl+C to stop."

# Wait for background processes
wait
