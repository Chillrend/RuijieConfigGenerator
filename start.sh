#!/bin/bash

# Function to clean up background processes on exit
cleanup() {
    echo "Stopping services..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit
}

# Set trap to call cleanup function on script exit (like Ctrl+C)
trap cleanup SIGINT SIGTERM EXIT

echo "Starting backend..."
npm run dev --prefix backend &
BACKEND_PID=$!

echo "Starting frontend..."
npm run dev --prefix frontend &
FRONTEND_PID=$!

echo "Both services are running. Press Ctrl+C to stop."

# Wait for background processes
wait
