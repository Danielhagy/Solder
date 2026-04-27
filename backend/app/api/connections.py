"""
Connections API — encrypted at rest, never round-trips plaintext.

Two flavours of connection share the table:

  - **Built-in** — `connector_id` references a registered `Connector`
    row (Zip, HubSpot). The connector's `auth_scheme` and `base_url`
    are inherited.
  - **Custom**   — `connector_id` null; the user picked one of the five
    `auth_schemes.SCHEMES` primitives directly and supplied a name.

POST receives plaintext secrets; this layer immediately splits them on
the schema's `secret` flag — secret keys go through
`connection_crypto.encrypt` to become `(ciphertext, nonce)`; non-secret
keys land in `config_json`. GET / list return the metadata only —
secrets never leave the server.

To use a connection at execution time, call
`connection_crypto.decrypt(row.ciphertext, row.nonce)` and feed the
result to `auth_schemes.apply(row.auth_scheme, secrets, config)`.
"""

from __future__ import annotations

from typing import Any, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.connectors import REGISTRY as CONNECTOR_REGISTRY
from app.connectors import auth_schemes
from app.database import get_db
from app.models import Connection, Connector
from app.schemas import ConnectionIn, ConnectionOut
from app.services import connection_crypto

router = APIRouter()


def _to_out(row: Connection) -> ConnectionOut:
    return ConnectionOut(
        id=row.id,
        connector_id=row.connector_id,
        label=row.label,
        auth_scheme=row.auth_scheme,
        base_url=row.base_url,
        config_json=row.config_json or {},
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("", response_model=list[ConnectionOut])
async def list_connections(
    connector_id: Optional[str] = Query(default=None),
    auth_scheme: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> list[ConnectionOut]:
    stmt = select(Connection)
    if connector_id:
        stmt = stmt.where(Connection.connector_id == connector_id)
    if auth_scheme:
        stmt = stmt.where(Connection.auth_scheme == auth_scheme)
    rows = list((await db.execute(stmt)).scalars().all())
    return [_to_out(r) for r in rows]


@router.post("", response_model=ConnectionOut, status_code=status.HTTP_201_CREATED)
async def create_connection(
    payload: ConnectionIn, db: AsyncSession = Depends(get_db)
) -> ConnectionOut:
    # Resolve the connector binding + scheme. Either:
    #   (a) connector_id given → look up the connector → scheme is its
    #       declared scheme (we still let an explicit `auth_scheme` in
    #       the payload override, in case a connector exposes multiple
    #       — none do today, but the model allows it).
    #   (b) connector_id null → custom connection; auth_scheme required.
    connector: Optional[Connector] = None
    if payload.connector_id is not None:
        connector = await db.get(Connector, payload.connector_id)
        if connector is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                detail=f"unknown connector_id {payload.connector_id!r}",
            )
    scheme_id = payload.auth_scheme or (connector.auth_scheme if connector else None)
    if scheme_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="auth_scheme is required when no connector_id is provided",
        )
    try:
        scheme = auth_schemes.get_scheme(scheme_id)
    except KeyError:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail=(
                f"unknown auth_scheme {scheme_id!r} — valid options: "
                + ", ".join(s.id for s in auth_schemes.SCHEMES)
            ),
        )

    # Validate the user's input against the scheme's required fields.
    # Required SECRET keys must appear in `payload.secrets`; required
    # PUBLIC keys must appear in `payload.config` (or default to the
    # scheme's `default` value).
    config = dict(payload.config)
    secrets = dict(payload.secrets)
    for field in scheme.fields:
        if field.required:
            bag = secrets if field.secret else config
            value = bag.get(field.key)
            if value in (None, ""):
                if not field.secret and field.default is not None:
                    config[field.key] = field.default
                    continue
                bucket = "secrets" if field.secret else "config"
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    detail=f"{bucket}.{field.key} is required for {scheme.id!r}",
                )

    if not secrets:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail="at least one secret value is required",
        )

    # Resolve base_url: explicit override → connector default → null.
    base_url = payload.base_url
    if base_url is None and connector is not None:
        base_url = connector.base_url

    ciphertext, nonce = connection_crypto.encrypt(secrets)
    row = Connection(
        id=str(uuid4()),
        connector_id=payload.connector_id,
        label=payload.label,
        auth_scheme=scheme.id,
        base_url=base_url,
        config_json=config,
        ciphertext=ciphertext,
        nonce=nonce,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _to_out(row)


@router.delete("/{connection_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_connection(
    connection_id: str, db: AsyncSession = Depends(get_db)
) -> None:
    row = await db.get(Connection, connection_id)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail=f"connection {connection_id!r} not found",
        )
    await db.delete(row)
    await db.commit()
