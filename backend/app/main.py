# Windows asyncio: force Proactor event loop policy at import time so
# subprocess-based activities (the Python sandbox) work under uvicorn.
# The default `SelectorEventLoop` on Windows raises `NotImplementedError`
# on `create_subprocess_exec`. Setting the *policy* here is sufficient
# because uvicorn picks up the active policy when it creates its loop;
# we just need to be importable before uvicorn instantiates the loop.
import sys as _sys

if _sys.platform == "win32":
    import asyncio as _asyncio

    _asyncio.set_event_loop_policy(_asyncio.WindowsProactorEventLoopPolicy())

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import (
    agents,
    connection_types,
    connections,
    connectors,
    dev,
    integrations,
    nodes,
    openapi,
    runs,
)
from app.config import settings
from app.database import engine
from app.database_migrations import run_dev_migrations
from app.mock_engine.router import router as mock_engine_router
from app.models import Base


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler.

    Order matters: dev migrations run twice — once before `create_all`
    (drops legacy tables/columns so the new schema can take), once after
    (adds `integration_connection_id` FKs that depend on the new
    `integration_connections` table create_all just made). Both passes
    are idempotent.
    """
    await run_dev_migrations(engine)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await run_dev_migrations(engine)
    yield
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
app.include_router(mock_engine_router, prefix="/api/mock", tags=["Mock Engine"])
app.include_router(connectors.router, prefix="/api/connectors", tags=["Connectors"])
app.include_router(connections.router, prefix="/api/connections", tags=["Connections"])
app.include_router(nodes.router, prefix="/api/nodes", tags=["Nodes"])
app.include_router(
    connection_types.router,
    prefix="/api/connection-types",
    tags=["Connection Types"],
)
app.include_router(dev.router, prefix="/api/dev", tags=["Dev"])


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": settings.app_name}
