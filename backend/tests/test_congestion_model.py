"""Inference parity with the supplied CBM, not accuracy claims or training."""
import hashlib
import math
import sys
import builtins

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.congestion_model import CATEGORICAL_INDICES, DEFAULT_MODEL_PATH, FEATURE_NAMES, CongestionModel, ModelUnavailable, prepare_row
from app.main import create_app
from app.model_schemas import ModelFeatures, ModelMetadata, ModelPredictionResponse
from app.settings import Settings

# Synthetic test input, not a recovered training row or a production district default.
INPUT = dict(hour=8, district="Центральный", is_main_road=1, day_of_week="Понедельник", season="Зима", lanes_total=4, population=100000)
MODEL_SHA256 = "4ccc8aa44af40c96784eed35e5b7516835172795da366bd889f0531317030706"


@pytest.fixture(scope="module")
def model():
    pytest.importorskip("catboost")
    return CongestionModel(DEFAULT_MODEL_PATH)


def test_artifact_is_identical_to_user_model():
    assert hashlib.sha256(DEFAULT_MODEL_PATH.read_bytes()).hexdigest() == MODEL_SHA256


def test_preparation_matches_notebook_and_cbm_order():
    features = ModelFeatures(**INPUT)
    row = prepare_row(features)
    assert len(row) == len(FEATURE_NAMES) == 11
    assert row[:7] == list(INPUT.values())
    assert row[7:] == pytest.approx([math.sin(2 * math.pi * 8 / 24), math.cos(2 * math.pi * 8 / 24), 0, 1])
    sunday = prepare_row(features.model_copy(update={"hour": 0, "day_of_week": "Воскресенье"}))
    assert sunday[7:] == pytest.approx([0, 1, math.sin(12 * math.pi / 7), math.cos(12 * math.pi / 7)])
    # The notebook used categorical strings verbatim, including whitespace.
    assert prepare_row(ModelFeatures(**{**INPUT, "season": " Зима "}))[4] == " Зима "


def test_actual_cbm_parity_determinism_and_hourly_consistency(model):
    from catboost import CatBoostRegressor, Pool
    direct = CatBoostRegressor()
    direct.load_model(str(DEFAULT_MODEL_PATH))
    features = ModelFeatures(**INPUT)
    raw = float(direct.predict(Pool([prepare_row(features)], feature_names=FEATURE_NAMES, cat_features=CATEGORICAL_INDICES))[0])
    result = model.predict(features, include_hourly_profile=True)
    assert result.prediction.value == pytest.approx(raw, abs=1e-12)
    assert raw == pytest.approx(4.573645405108514, abs=1e-12)
    assert result.model_version == "catboost-4ccc8aa44af40c96"
    assert result.model_dump() == model.predict(features, True).model_dump()
    assert [point.hour for point in result.hourly_profile] == list(range(24))
    assert len({point.value for point in result.hourly_profile}) > 1
    for hour in (0, 8, 18, 23):
        assert model.predict(features.model_copy(update={"hour": hour})).prediction.value == pytest.approx(result.hourly_profile[hour].value, abs=1e-12)


@pytest.mark.parametrize("field,value", [("population", None), ("population", -1), ("population", True), ("population", 10**100), ("lanes_total", 0), ("lanes_total", 2.5), ("hour", 24), ("hour", "08:00"), ("is_main_road", 2), ("district", "Неизвестный"), ("day_of_week", "Monday"), ("season", " ")])
def test_missing_and_invalid_inputs_are_not_imputed(field, value):
    with pytest.raises(ValidationError):
        ModelFeatures(**{**INPUT, field: value})


def test_zero_population_is_not_a_missing_value(model):
    value = model.predict(ModelFeatures(**{**INPUT, "population": 0}))
    assert value.features.population == 0
    assert math.isfinite(value.prediction.value)


def test_regressor_output_is_not_clipped_to_expected_range():
    class FakeModel:
        def predict(self, _pool, **_kwargs):
            return [12.75]
    pytest.importorskip("catboost")
    service = CongestionModel()
    service._model = FakeModel()
    value = service.predict(ModelFeatures(**INPUT))
    assert value.prediction.value == 12.75
    assert value.prediction.out_of_expected_range
    assert any("без обрезки" in warning for warning in value.warnings)


def test_http_metadata_prediction_errors_and_cors(model):
    with TestClient(create_app(congestion_model=model)) as client:
        response = client.get("/api/v1/model/metadata")
        assert response.status_code == 200
        metadata = ModelMetadata.model_validate(response.json())
        assert metadata.status == "ready" and metadata.model_sha256 == MODEL_SHA256
        assert metadata.has_year_feature is False
        assert len(metadata.features) == 7
        geography_ids = {feature.id for feature in metadata.geography.boundaries.features}
        assert {district.feature_id for district in metadata.districts} <= geography_ids
        assert next(f for f in metadata.features if f.name == "season").options == ["Лето", "Не лето"]
        response = client.post("/api/v1/model/predict", json={"features": INPUT, "include_hourly_profile": True})
        assert response.status_code == 200
        result = ModelPredictionResponse.model_validate(response.json())
        assert result.prediction.unit == "балл" and result.feature_id == "district-tsentralny"
        missing = {key: value for key, value in INPUT.items() if key != "population"}
        for payload in ({"features": missing}, {"features": INPUT, "year": 2030}):
            error = client.post("/api/v1/model/predict", json=payload)
            assert error.status_code == 422 and error.json()["error"]["code"] == "validation_error"
        preflight = client.options("/api/v1/model/predict", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"})
        assert preflight.status_code == 200
        assert preflight.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_missing_model_is_explicit_and_never_falls_back(tmp_path):
    with TestClient(create_app(settings=Settings(catboost_model_path=tmp_path / "missing.cbm"))) as client:
        meta = client.get("/api/v1/model/metadata").json()
        assert meta["status"] == "unavailable" and meta["unavailable_reason"]
        assert client.get("/api/v1/health").json()["congestion_model_status"] == "unavailable"
        result = client.post("/api/v1/model/predict", json={"features": INPUT})
        assert result.status_code == 503
        assert result.json()["error"]["code"] == "service_unavailable"
        assert "prediction" not in result.json()


def test_incompatible_artifact_is_not_loaded(tmp_path):
    bad = tmp_path / "bad.cbm"
    bad.write_bytes(b"invalid")
    with pytest.raises(ModelUnavailable, match="CBM"):
        CongestionModel(bad).predict(ModelFeatures(**INPUT))


def test_absent_runtime_dependency_is_reported_without_fake_results(monkeypatch):
    monkeypatch.setitem(sys.modules, "catboost", None)
    service = CongestionModel(DEFAULT_MODEL_PATH)
    status, reason = service.status()
    assert status == "unavailable" and "requirements-model.lock" in reason
    with pytest.raises(ModelUnavailable):
        service.predict(ModelFeatures(**INPUT))


def test_broken_native_runtime_is_reported_as_unavailable(monkeypatch):
    original_import = builtins.__import__

    def broken_import(name, *args, **kwargs):
        if name == "catboost":
            raise OSError("native library cannot load")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", broken_import)
    status, reason = CongestionModel(DEFAULT_MODEL_PATH).status()
    assert status == "unavailable" and "requirements-model.lock" in reason
