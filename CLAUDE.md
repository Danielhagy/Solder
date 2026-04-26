# Solder - Project Status

## What's Built (Phase 1 MVP Complete)

### Backend (Python/FastAPI)
- REST API with endpoints for integrations, runs, OpenAPI specs, AI agents
- SQLAlchemy models with PostgreSQL support
- OpenAPI scraper using Playwright
- Claude AI integration for building integrations
- Temporal workflows for durable execution

### Frontend (React + Vite + TypeScript)
- React 18, Vite dev server, React Router, Zustand state
- React Flow canvas for the node graph
- framer-motion for dialog/node transitions
- Tailwind (Inter + JetBrains Mono), custom `shadow-node` tokens
- Node types: API Call, Transform, Condition, Output
- Properties panel for node configuration
- Run history viewer
- API documentation browser

**Note:** the frontend was ported from SvelteKit to React in April 2026. The only `frontend/` on disk is the React app.

### Infrastructure
- Docker Compose with PostgreSQL + Temporal
- Startup scripts (start.ps1, start.sh)

## How to Run

1. Install Docker Desktop
2. Run: `.\start.ps1` (PowerShell) or `./start.sh` (bash)
3. Open http://localhost:5173

## QA

Playwright harness at `qa/qa_harness.py` smoke + interaction tests all routes. Run: `python qa/qa_harness.py`. Artifacts land in `qa/artifacts/`.

## After Windows Reset

If dependencies are missing, reinstall:
```bash
# Backend
cd backend
pip install fastapi uvicorn sqlalchemy asyncpg alembic pydantic pydantic-settings httpx playwright pyyaml temporalio anthropic python-multipart

# Frontend
cd frontend
npm install
```

## Configuration

Set your Claude API key in `backend/.env`:
```
ANTHROPIC_API_KEY=your-key-here
```
