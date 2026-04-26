import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_check():
    """Test the health check endpoint."""
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "healthy"
    assert data["service"] == "Solder"


def test_list_integrations_empty():
    """Test listing integrations when empty."""
    response = client.get("/api/integrations")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_list_runs_empty():
    """Test listing runs when empty."""
    response = client.get("/api/runs")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_list_openapi_specs_empty():
    """Test listing OpenAPI specs when empty."""
    response = client.get("/api/openapi")
    assert response.status_code == 200
    assert isinstance(response.json(), list)
