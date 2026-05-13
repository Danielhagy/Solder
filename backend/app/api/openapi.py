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


@router.get("/{spec_id}/endpoints")
async def list_spec_endpoints(spec_id: str, db: AsyncSession = Depends(get_db)):
    """Flat per-operation listing for the "Sandbox from Spec" wizard.

    Returns one row per (method, path) pair so the frontend can render
    a checklist without re-parsing the full spec on the client. Tags
    let the wizard offer prefilter chips ("Bills", "Vendors", ...).
    """
    result = await db.execute(select(OpenAPISpec).where(OpenAPISpec.id == spec_id))
    spec = result.scalar_one_or_none()
    if not spec:
        raise HTTPException(status_code=404, detail="OpenAPI spec not found")

    paths = (spec.spec_json or {}).get("paths", {}) or {}
    out: list[dict] = []
    seen_tags: set[str] = set()
    for path, methods in paths.items():
        if not isinstance(methods, dict):
            continue
        for method_name, op in methods.items():
            if method_name.upper() not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                continue
            if not isinstance(op, dict):
                continue
            tags = op.get("tags") or []
            for t in tags:
                if isinstance(t, str):
                    seen_tags.add(t)
            out.append(
                {
                    "method": method_name.upper(),
                    "path": path,
                    "operation_id": op.get("operationId"),
                    "summary": op.get("summary") or "",
                    "tags": [t for t in tags if isinstance(t, str)],
                    "deprecated": bool(op.get("deprecated", False)),
                }
            )
    out.sort(key=lambda e: (e["path"], e["method"]))
    return {
        "spec_id": str(spec.id),
        "name": spec.name,
        "version": spec.version,
        "endpoints": out,
        "tags": sorted(seen_tags),
        "total": len(out),
    }
