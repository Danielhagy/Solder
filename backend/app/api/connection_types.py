"""
Connection-types catalog — read-only list of the five primitive auth
schemes the frontend renders in the "+ New connection" picker.

This is a pure projection of `connectors/auth_schemes.py:SCHEMES`. The
frontend uses it to (a) populate the connection-type dropdown and
(b) render the right form fields per scheme without hard-coding the
shape on the client.

Adding a new connection type is a backend code change in
`auth_schemes.py`; the new entry shows up here automatically.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.connectors import auth_schemes

router = APIRouter()


class ConnectionTypeField(BaseModel):
    key: str
    label: str
    secret: bool
    required: bool
    default: str | None = None
    placeholder: str | None = None
    help: str | None = None


class ConnectionType(BaseModel):
    id: str
    label: str
    description: str
    fields: list[ConnectionTypeField]


@router.get("", response_model=list[ConnectionType])
async def list_connection_types() -> list[ConnectionType]:
    return [
        ConnectionType(
            id=s.id,
            label=s.label,
            description=s.description,
            fields=[
                ConnectionTypeField(
                    key=f.key,
                    label=f.label,
                    secret=f.secret,
                    required=f.required,
                    default=f.default,
                    placeholder=f.placeholder,
                    help=f.help,
                )
                for f in s.fields
            ],
        )
        for s in auth_schemes.SCHEMES
    ]
