#!/bin/bash

# Solder - Low-Code Integration Platform
# Startup Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║           SOLDER - Low-Code Integration Platform          ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Function to check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Function to wait for a service to be ready
wait_for_service() {
    local host=$1
    local port=$2
    local service=$3
    local max_attempts=30
    local attempt=1

    echo -e "${YELLOW}Waiting for $service to be ready...${NC}"
    while ! nc -z "$host" "$port" 2>/dev/null; do
        if [ $attempt -ge $max_attempts ]; then
            echo -e "${RED}$service failed to start after $max_attempts attempts${NC}"
            return 1
        fi
        echo -n "."
        sleep 2
        ((attempt++))
    done
    echo -e "\n${GREEN}$service is ready!${NC}"
}

# Check prerequisites
echo -e "${BLUE}[1/6] Checking prerequisites...${NC}"

if ! command_exists docker; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    exit 1
fi

if ! command_exists node; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    exit 1
fi

if ! command_exists python; then
    echo -e "${RED}Error: Python is not installed${NC}"
    exit 1
fi

echo -e "${GREEN}All prerequisites found!${NC}"

# Start Docker services
echo -e "\n${BLUE}[2/6] Starting Docker services (PostgreSQL + Temporal)...${NC}"
docker-compose up -d

# Wait for PostgreSQL
wait_for_service localhost 5432 "PostgreSQL"

# Wait for Temporal
wait_for_service localhost 7233 "Temporal"

# Setup backend
echo -e "\n${BLUE}[3/6] Setting up backend...${NC}"
cd "$SCRIPT_DIR/backend"

# Check if poetry is installed, if not use pip
if command_exists poetry; then
    echo "Using Poetry for dependency management..."
    poetry install --no-interaction 2>/dev/null || {
        echo -e "${YELLOW}Poetry install failed, trying pip...${NC}"
        pip install -e . 2>/dev/null || pip install fastapi uvicorn sqlalchemy asyncpg alembic pydantic pydantic-settings httpx playwright pyyaml temporalio anthropic python-multipart
    }
else
    echo "Poetry not found, using pip..."
    pip install fastapi uvicorn sqlalchemy asyncpg alembic pydantic pydantic-settings httpx playwright pyyaml temporalio anthropic python-multipart
fi

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env file from template..."
    cp .env.example .env 2>/dev/null || cat > .env << 'EOF'
DATABASE_URL=postgresql+asyncpg://solder:solder_secret@localhost:5432/solder
TEMPORAL_HOST=localhost:7233
TEMPORAL_NAMESPACE=default
TEMPORAL_TASK_QUEUE=solder-tasks
ANTHROPIC_API_KEY=
CORS_ORIGINS=["http://localhost:5173", "http://localhost:3000"]
DEBUG=true
EOF
fi

# Setup frontend
echo -e "\n${BLUE}[4/6] Setting up frontend...${NC}"
cd "$SCRIPT_DIR/frontend"
npm install

# Start backend in background
echo -e "\n${BLUE}[5/6] Starting backend server...${NC}"
cd "$SCRIPT_DIR/backend"

if command_exists poetry; then
    poetry run uvicorn app.main:app --reload --port 8000 &
else
    python -m uvicorn app.main:app --reload --port 8000 &
fi
BACKEND_PID=$!
echo "Backend started with PID: $BACKEND_PID"

# Wait for backend
sleep 3
wait_for_service localhost 8000 "Backend API"

# Start frontend
echo -e "\n${BLUE}[6/6] Starting frontend server...${NC}"
cd "$SCRIPT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!
echo "Frontend started with PID: $FRONTEND_PID"

# Wait for frontend
sleep 3

echo -e "\n${GREEN}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                    SOLDER IS RUNNING!                     ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║                                                           ║"
echo "║  Frontend:     http://localhost:5173                      ║"
echo "║  Backend API:  http://localhost:8000/docs                 ║"
echo "║  Temporal UI:  http://localhost:8080                      ║"
echo "║                                                           ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║  Press Ctrl+C to stop all services                        ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Trap to cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down services...${NC}"
    kill $BACKEND_PID 2>/dev/null
    kill $FRONTEND_PID 2>/dev/null
    echo -e "${YELLOW}Stopping Docker services...${NC}"
    cd "$SCRIPT_DIR"
    docker-compose down
    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for processes
wait
