# Solder - Low-Code Integration Platform

A low-code integration platform powered by AI agents that enables users to build, test, and deploy integrations through an intuitive drag-and-drop interface.

## Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 18+
- Python 3.11+
- Poetry

### Development Setup

1. **Start infrastructure services:**
```bash
docker-compose up -d
```

2. **Start the backend:**
```bash
cd backend
poetry install
poetry run uvicorn app.main:app --reload --port 8000
```

3. **Start the frontend:**
```bash
cd frontend
npm install
npm run dev
```

4. **Access the application:**
- Frontend: http://localhost:5173
- Backend API: http://localhost:8000/docs
- Temporal UI: http://localhost:8080

## Project Structure

```
solder/
├── frontend/           # SvelteKit application
├── backend/            # FastAPI application
├── docker-compose.yml  # Infrastructure services
└── README.md
```

## Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | SvelteKit + TypeScript + Tailwind CSS |
| Backend | Python + FastAPI + SQLAlchemy |
| Workflow | Temporal |
| Database | PostgreSQL |
| AI | Claude API |
| Scraping | Playwright |
