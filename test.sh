#!/bin/bash
set -e

# Kill any existing processes
lsof -ti:9099 | xargs kill -9 2>/dev/null || true
lsof -ti:8081 | xargs kill -9 2>/dev/null || true
lsof -ti:8082 | xargs kill -9 2>/dev/null || true
lsof -ti:8083 | xargs kill -9 2>/dev/null || true
rm -rf recordings testing

echo "Starting backends..."
npx tsx test_backend.ts &
BACKENDS_PID=$!
sleep 3

echo "Starting proxy in RECORD mode..."
export PORT=9099
export PRIMARY_BACKEND=http://localhost:8081
export BACKEND_1=http://localhost:8082
export TESTING_BACKEND=http://localhost:8083

npx tsx proxy.ts --mode record --id test1 &
PROXY_PID=$!
sleep 3

echo "Testing GET request..."
curl -s "http://localhost:9099/api/users?id=123"
echo -e "\n\nTesting POST request..."
curl -s -X POST -H "Content-Type: application/json" -d '{"name":"Alice"}' "http://localhost:9099/api/users"
echo -e "\n\nWaiting for secondaries..."
sleep 3

echo "Killing proxy..."
lsof -ti:9099 | xargs kill -9 2>/dev/null || true
sleep 2

echo "Starting proxy in REPLAY mode..."
npx tsx proxy.ts --mode replay --id test1 &
sleep 3

echo "Testing GET request (should be mocked)..."
curl -s "http://localhost:9099/api/users?id=123"
echo -e "\n\nTesting POST request (should be mocked)..."
curl -s -X POST -H "Content-Type: application/json" -d '{"name":"Alice"}' "http://localhost:9099/api/users"
echo -e "\n\n"

echo "Killing proxy..."
lsof -ti:9099 | xargs kill -9 2>/dev/null || true
sleep 2

echo "Testing VERIFY (Test Runner) mode..."
npx tsx proxy.ts --mode verify --id test1

echo "Killing backends..."
kill -9 $BACKENDS_PID || true
lsof -ti:8081 | xargs kill -9 2>/dev/null || true
lsof -ti:8082 | xargs kill -9 2>/dev/null || true
lsof -ti:8083 | xargs kill -9 2>/dev/null || true
