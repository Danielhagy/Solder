from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Integration, OpenAPISpec
from app.services.agent import IntegrationAgent

router = APIRouter()


class BuildRequest(BaseModel):
    """Request to build an integration with AI assistance."""

    description: str
    openapi_spec_id: Optional[str] = None
    existing_integration_id: Optional[str] = None


class BuildResponse(BaseModel):
    """Response from AI-assisted build."""

    integration_config: dict
    explanation: str
    suggested_name: str


class TestRequest(BaseModel):
    """Request to test an integration."""

    integration_id: str
    test_input: Optional[dict] = None


class TestResponse(BaseModel):
    """Response from integration test."""

    success: bool
    output: Optional[dict] = None
    error: Optional[str] = None
    suggestions: list[str] = []


@router.post("/build", response_model=BuildResponse)
async def build_integration(request: BuildRequest, db: AsyncSession = Depends(get_db)):
    """Use AI agent to build an integration from description."""
    agent = IntegrationAgent()

    # Get OpenAPI spec context if provided
    openapi_context = None
    if request.openapi_spec_id:
        result = await db.execute(
            select(OpenAPISpec).where(OpenAPISpec.id == request.openapi_spec_id)
        )
        spec = result.scalar_one_or_none()
        if spec:
            openapi_context = spec.parsed_markdown or str(spec.spec_json)

    # Get existing integration if modifying
    existing_config = None
    if request.existing_integration_id:
        result = await db.execute(
            select(Integration).where(Integration.id == request.existing_integration_id)
        )
        integration = result.scalar_one_or_none()
        if integration:
            existing_config = integration.config

    try:
        result = await agent.build_integration(
            description=request.description,
            openapi_context=openapi_context,
            existing_config=existing_config,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI agent error: {str(e)}")


@router.post("/test", response_model=TestResponse)
async def test_integration(request: TestRequest, db: AsyncSession = Depends(get_db)):
    """Test an integration and get AI suggestions for improvement."""
    result = await db.execute(
        select(Integration).where(Integration.id == request.integration_id)
    )
    integration = result.scalar_one_or_none()
    if not integration:
        raise HTTPException(status_code=404, detail="Integration not found")

    agent = IntegrationAgent()

    try:
        test_result = await agent.test_integration(
            config=integration.config,
            test_input=request.test_input,
        )
        return test_result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Test error: {str(e)}")


@router.post("/learn")
async def record_learning(
    run_id: str,
    success: bool,
    context: dict,
    db: AsyncSession = Depends(get_db),
):
    """Record AI learning from a run result."""
    from app.models import AILearning

    learning = AILearning(
        run_id=run_id,
        pattern_type="run_result",
        context=context,
        insight=f"Run {'succeeded' if success else 'failed'}",
        success_rate=1.0 if success else 0.0,
        usage_count=1,
    )
    db.add(learning)
    await db.commit()
    return {"status": "recorded"}
