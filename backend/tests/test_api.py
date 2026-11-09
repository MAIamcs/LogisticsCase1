import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.main import app
from app.models import PlanningResponse
from app.services import FIXTURE_DIR, get_planning_service


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client
    app.dependency_overrides.clear()


def test_health_is_explicit_about_absent_model(client):
    assert client.get("/api/v1/health").json() == {
        "status": "ok", "service": "transport-planning-api", "model_status": "not_integrated",
    }


def test_api_catalog_equals_canonical_demo_fixture(client):
    response = client.get("/api/v1/scenarios")
    assert response.status_code == 200
    assert response.json() == json.loads((FIXTURE_DIR / "scenarios.json").read_text())


@pytest.mark.parametrize("scenario_id", ["morning", "evening"])
def test_api_scenario_equals_demo_including_provenance_and_geometry(client, scenario_id):
    response = client.get(f"/api/v1/scenarios/{scenario_id}")
    assert response.status_code == 200
    fixture = json.loads((FIXTURE_DIR / f"{scenario_id}.json").read_text())
    assert response.json() == fixture
    parsed = PlanningResponse.model_validate(fixture)
    assert parsed.meta.is_synthetic is True
    assert parsed.meta.source == "synthetic"
    values = [f.properties for f in parsed.data.corridors.features]
    assert parsed.data.summary.daily_trips == sum(p.daily_trips for p in values)
    assert parsed.data.summary.mean_travel_time_min == round(sum(p.travel_time_min for p in values) / len(values), 1)
    assert parsed.data.summary.mean_load_percent == round(sum(p.load_percent for p in values) / len(values), 1)


def test_unknown_scenario_has_stable_error_envelope(client):
    response = client.get("/api/v1/scenarios/unknown")
    assert response.status_code == 404
    assert response.json() == {"error": {"code": "not_found", "message": "Scenario not found"}}


def test_invalid_scenario_id_is_rejected(client):
    response = client.get("/api/v1/scenarios/invalid.name")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_cors_accepts_local_frontend_but_not_unknown_origin(client):
    allowed = client.get("/api/v1/scenarios", headers={"Origin": "http://localhost:5173"})
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    denied = client.get("/api/v1/scenarios", headers={"Origin": "https://unexpected.example"})
    assert "access-control-allow-origin" not in denied.headers


def test_cors_preflight(client):
    response = client.options("/api/v1/scenarios", headers={
        "Origin": "http://127.0.0.1:5173", "Access-Control-Request-Method": "GET",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"


def test_model_adapter_can_be_replaced_without_route_changes(client):
    class ModelAdapter:
        def get_scenario(self, scenario_id):
            value = json.loads((FIXTURE_DIR / f"{scenario_id}.json").read_text())
            value["meta"].update(source="model", is_synthetic=False, disclaimer="Test model output; not a deployed analytical model")
            return PlanningResponse.model_validate(value)

    app.dependency_overrides[get_planning_service] = ModelAdapter
    response = client.get("/api/v1/scenarios/morning")
    assert response.status_code == 200
    assert response.json()["meta"]["source"] == "model"
    assert response.json()["meta"]["is_synthetic"] is False


def test_provenance_cannot_contradict_source():
    fixture = json.loads((FIXTURE_DIR / "morning.json").read_text())
    fixture["meta"]["is_synthetic"] = False
    with pytest.raises(ValidationError):
        PlanningResponse.model_validate(fixture)


def test_service_error_is_json_and_does_not_expose_exception():
    class BrokenAdapter:
        def list_scenarios(self):
            raise RuntimeError("private diagnostic")

    app.dependency_overrides[get_planning_service] = BrokenAdapter
    try:
        with TestClient(app, raise_server_exceptions=False) as client:
            response = client.get("/api/v1/scenarios")
            assert response.status_code == 500
            assert response.json() == {"error": {"code": "internal_error", "message": "Planning service failed"}}
    finally:
        app.dependency_overrides.clear()
