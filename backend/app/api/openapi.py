from typing import List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import OpenAPISpec
from app.schemas import OpenAPISpecCreate, OpenAPISpecResponse
from app.services.parser import OpenAPIParser
from app.services.scraper import OpenAPIScraper

router = APIRouter()


@router.get("", response_model=List[OpenAPISpecResponse])
async def list_openapi_specs(
    skip: int = 0, limit: int = 100, db: AsyncSession = Depends(get_db)
):
    """List all OpenAPI specifications."""
    result = await db.execute(
        select(OpenAPISpec).offset(skip).limit(limit).order_by(OpenAPISpec.created_at.desc())
    )
    return result.scalars().all()


@router.post("/fetch", response_model=OpenAPISpecResponse, status_code=201)
async def fetch_openapi_spec(url: str, name: str, db: AsyncSession = Depends(get_db)):
    """Fetch and parse an OpenAPI specification from a URL."""
    scraper = OpenAPIScraper()
    parser = OpenAPIParser()

    try:
        spec_json = await scraper.fetch_spec(url)
        parsed_markdown = parser.to_markdown(spec_json)
        version = spec_json.get("openapi", spec_json.get("swagger", "3.0.0"))

        db_spec = OpenAPISpec(
            name=name,
            url=url,
            version=version,
            spec_json=spec_json,
            parsed_markdown=parsed_markdown,
        )
        db.add(db_spec)
        await db.commit()
        await db.refresh(db_spec)
        return db_spec

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch spec: {str(e)}")


@router.post("/upload", response_model=OpenAPISpecResponse, status_code=201)
async def upload_openapi_spec(
    name: str, file: UploadFile = File(...), db: AsyncSession = Depends(get_db)
):
    """Upload an OpenAPI specification file."""
    import json
    import yaml

    content = await file.read()
    content_str = content.decode("utf-8")

    # Try parsing as JSON first, then YAML
    try:
        spec_json = json.loads(content_str)
    except json.JSONDecodeError:
        try:
            spec_json = yaml.safe_load(content_str)
        except yaml.YAMLError as e:
            raise HTTPException(
                status_code=400, detail=f"Invalid JSON or YAML: {str(e)}"
            )

    parser = OpenAPIParser()
    parsed_markdown = parser.to_markdown(spec_json)
    version = spec_json.get("openapi", spec_json.get("swagger", "3.0.0"))

    db_spec = OpenAPISpec(
        name=name,
        version=version,
        spec_json=spec_json,
        parsed_markdown=parsed_markdown,
    )
    db.add(db_spec)
    await db.commit()
    await db.refresh(db_spec)
    return db_spec


@router.get("/{spec_id}", response_model=OpenAPISpecResponse)
async def get_openapi_spec(spec_id: str, db: AsyncSession = Depends(get_db)):
    """Get an OpenAPI specification by ID."""
    result = await db.execute(select(OpenAPISpec).where(OpenAPISpec.id == spec_id))
    spec = result.scalar_one_or_none()
    if not spec:
        raise HTTPException(status_code=404, detail="OpenAPI spec not found")
    return spec


@router.delete("/{spec_id}", status_code=204)
async def delete_openapi_spec(spec_id: str, db: AsyncSession = Depends(get_db)):
    """Delete an OpenAPI specification."""
    result = await db.execute(select(OpenAPISpec).where(OpenAPISpec.id == spec_id))
    spec = result.scalar_one_or_none()
    if not spec:
        raise HTTPException(status_code=404, detail="OpenAPI spec not found")

    await db.delete(spec)
    await db.commit()
