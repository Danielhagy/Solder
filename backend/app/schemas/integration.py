from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator

from app.models.integration import RunStatus


# Integration schemas
class IntegrationCreate(BaseModel):
    """Schema for creating an integration."""

    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    config: dict = Field(default_factory=dict)
    trigger: Optional[dict] = None  # Defaults to {"type":"manual"} in the model
    status: Optional[str] = None  # draft|active|disabled
    is_library: Optional[bool] = False  # Reusable subprocess?


class IntegrationUpdate(BaseModel):
    """Schema for updating an integration."""

    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    config: Optional[dict] = None
    is_active: Optional[bool] = None
    trigger: Optional[dict] = None
    status: Optional[str] = None
    is_library: Optional[bool] = None


class IntegrationResponse(BaseModel):
    """Schema for integration response."""

    id: str
    name: str
    description: Optional[str]
    config: dict
    is_active: bool
    status: str = "draft"
    trigger: dict = Field(default_factory=lambda: {"type": "manual"})
    is_library: bool = False
    created_at: datetime
    updated_at: datetime

    # Legacy rows may have trigger=NULL; coerce to the default rather than 500.
    @field_validator("trigger", mode="before")
    @classmethod
    def _default_trigger(cls, v: Any) -> Any:
        if v is None:
            return {"type": "manual"}
        return v

    class Config:
        from_attributes = True


# Integration version schemas
class IntegrationVersionResponse(BaseModel):
    """Schema for a frozen integration version snapshot."""

    id: str
    integration_id: str
    version_number: int
    name: str
    description: Optional[str]
    config: dict
    trigger: dict
    is_library: bool
    change_summary: str
    created_at: datetime

    class Config:
        from_attributes = True


# OpenAPI spec schemas
class OpenAPISpecCreate(BaseModel):
    """Schema for creating an OpenAPI spec."""

    name: str = Field(..., min_length=1, max_length=255)
    url: Optional[str] = None
    spec_json: dict
    integration_id: Optional[str] = None


class OpenAPISpecResponse(BaseModel):
    """Schema for OpenAPI spec response."""

    id: str
    name: str
    url: Optional[str]
    version: str
    spec_json: dict
    parsed_markdown: Optional[str]
    integration_id: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Run schemas
class RunCreate(BaseModel):
    """Schema for creating a run."""

    integration_id: str
    input_data: Optional[dict] = None
    trigger_source: Optional[str] = None  # manual|webhook|schedule|on_event


class RunUpdate(BaseModel):
    """Schema for updating a run."""

    status: Optional[RunStatus] = None
    output_data: Optional[dict] = None
    error_message: Optional[str] = None
    steps: Optional[list] = None


class RunResponse(BaseModel):
    """Schema for run response."""

    id: str
    integration_id: str
    status: str
    input_data: Optional[dict]
    output_data: Optional[dict]
    error_message: Optional[str]
    steps: list
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    temporal_workflow_id: Optional[str]
    trigger_source: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# AI Learning schemas
class AILearningCreate(BaseModel):
    """Schema for creating an AI learning."""

    run_id: Optional[str] = None
    integration_id: Optional[str] = None
    pattern_type: str
    context: dict
    insight: str


class AILearningResponse(BaseModel):
    """Schema for AI learning response."""

    id: str
    run_id: Optional[str]
    integration_id: Optional[str]
    pattern_type: str
    context: dict
    insight: str
    success_rate: float
    usage_count: int
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
