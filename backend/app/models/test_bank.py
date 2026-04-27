"""
Test bank — synthetic mirror of a connector's data, generated during
discovery + synthesis (spec §§ 5.2, 6.2, 7.1, 7.2).

A `TestBank` carries the schema/classification metadata for one side
(source or target) of one integration. `TestBankEntity` rows are the
actual synthesized records; the mock-engine reads them on every GET/list.
"""

from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Index, String, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class TestBank(Base, TimestampMixin):
    """Per-(integration, side) synthetic data store."""

    __tablename__ = "test_banks"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    integration_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("integrations.id"), nullable=False, index=True
    )
    # The connector's stable name (e.g. "zip"). Mirrored from Connector.name so
    # the mock-engine doesn't need a join to resolve which corpus to consult.
    api_name: Mapped[str] = mapped_column(String(64), nullable=False)
    # Field classifications keyed by JSON path. See spec § 7.1.
    schema_json: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    # Enum values per field (full distinct list from sampling).
    value_sets: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    # field_path -> pii_type, e.g. {"vendor.contact_email": "pii_email"}.
    pii_classifications: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    refreshed_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    source_sample_size: Mapped[int] = mapped_column(default=0, nullable=False)

    entities: Mapped[list["TestBankEntity"]] = relationship(back_populates="test_bank")


class TestBankEntity(Base, TimestampMixin):
    """One synthesized record inside a test bank."""

    __tablename__ = "test_bank_entities"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    test_bank_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("test_banks.id"), nullable=False
    )
    # The catalog of entity types is connector-defined: 'purchase_order',
    # 'vendor', 'user', etc. Mirrored from the mock spec's `entity_type`.
    entity_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # Synthesized id, stable across regenerations so references hold.
    entity_id: Mapped[str] = mapped_column(String(128), nullable=False)
    data: Mapped[dict] = mapped_column(JSONB, nullable=False)
    # The most field-populated record observed during sampling — used as the
    # default test input in the per-node test dialog (spec § 8.3).
    is_golden: Mapped[bool] = mapped_column(
        default=False, server_default=text("false"), nullable=False
    )
    # Outbound references, e.g. {"vendor_id": {"entity_type": "vendor", "entity_id": "v_..."}}.
    references: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )

    test_bank: Mapped["TestBank"] = relationship(back_populates="entities")

    __table_args__ = (
        Index("ix_tbe_bank_type", "test_bank_id", "entity_type"),
        Index(
            "ix_tbe_bank_type_id", "test_bank_id", "entity_type", "entity_id", unique=True
        ),
    )
