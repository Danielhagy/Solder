from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings."""

    app_name: str = "Solder"
    debug: bool = True

    # Database
    database_url: str = "postgresql+asyncpg://solder:solder_secret@localhost:5432/solder"

    # Temporal
    temporal_host: str = "localhost:7233"
    temporal_namespace: str = "default"
    temporal_task_queue: str = "solder-tasks"

    # Claude API
    anthropic_api_key: str = ""

    # CORS
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    # Backend self-base — workflow connector ops route sandbox traffic
    # back through `/api/mock/...` on this host.
    api_base_url: str = "http://localhost:8000"

    class Config:
        env_file = ".env"


settings = Settings()
