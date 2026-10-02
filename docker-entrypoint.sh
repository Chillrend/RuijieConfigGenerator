#!/bin/sh
set -e

if [ "$1" = "listener" ]; then
  echo "Starting Ruijie gRPC Telemetry Listener on port 50051..."
  exec node grpc-listener.js
elif [ "$1" = "backend" ]; then
  echo "Starting Ruijie Web & API Backend on port 3001..."
  exec node server.js
else
  echo "Starting Ruijie gRPC Listener in background..."
  node grpc-listener.js &
  echo "Starting Ruijie Web & API Backend..."
  exec node server.js "$@"
fi
