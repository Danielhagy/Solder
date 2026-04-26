from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import agents, integrations, openapi, runs
from app.config import settings
from app.database import engine
from app.models import Base


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup: create database tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    # Shutdown: cleanup
    await engine.dispose()


app = FastAPI(
    title=settings.app_name,
    description="Low-code integration platform powered by AI agents",
    version="0.1.0",
    lifespan=lifespan,
)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(integrations.router, prefix="/api/integrations", tags=["Integrations"])
app.include_router(runs.router, prefix="/api/runs", tags=["Runs"])
app.include_router(openapi.router, prefix="/api/openapi", tags=["OpenAPI"])
app.include_router(agents.router, prefix="/api/agents", tags=["Agents"])


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": settings.app_name}
