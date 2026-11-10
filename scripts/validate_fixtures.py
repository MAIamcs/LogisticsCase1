"""Validate every shipped fixture with the authoritative FastAPI/Pydantic schemas.

Run after scripts/export_contract.py --check. The exported JSON Schemas and
TypeScript originate from these same models; model validators additionally check
null/zero semantics, geography identity, aggregates and critical intervals.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.forecast_models import ForecastMetadataResponse, ForecastResponse, Geography, GeographyLayerCollection, GeographySource
from app.forecast_provider import validate_provider_response
from app.models import PlanningResponse, ScenarioListResponse


def read(path: Path):
    def invalid_constant(value: str):
        raise ValueError(f"Non-finite JSON constant {value}")
    return json.loads(path.read_text(encoding="utf-8"), parse_constant=invalid_constant)


def main() -> None:
    fixtures = ROOT / "contracts" / "fixtures"
    forecast_dir = fixtures / "forecast"
    parsed = ForecastMetadataResponse.model_validate(read(forecast_dir / "metadata.json"))
    if not parsed.is_demo:
        raise ValueError("Static forecast metadata must declare is_demo=true")
    geography = Geography.model_validate(read(forecast_dir / "geography.json"))
    if geography != parsed.geography:
        raise ValueError("Static geography must equal metadata.geography")
    expected_forecasts = {
        forecast_dir / scenario.id / metric.id / f"{year}.json"
        for scenario in parsed.scenarios for metric in parsed.metrics for year in parsed.available_years
    }
    expected_json = expected_forecasts | {forecast_dir / "metadata.json", forecast_dir / "geography.json"}
    if set(forecast_dir.rglob("*.json")) != expected_json:
        raise ValueError("Forecast fixture tree must match exactly the metadata catalog")
    for path in sorted(expected_forecasts):
        response = ForecastResponse.model_validate(read(path))
        scenario, metric, year = path.relative_to(forecast_dir).parts
        validate_provider_response(parsed, response, year=int(Path(year).stem), metric=metric, scenario=scenario)
        if not response.is_demo:
            raise ValueError(f"Static forecast must declare is_demo=true: {path.relative_to(ROOT)}")

    from app.model_schemas import ModelMetadata, ModelPredictionResponse
    model_metadata = ModelMetadata.model_validate(read(fixtures / 'model/metadata.json'))
    model_predictions = [ModelPredictionResponse.model_validate(row) for row in read(fixtures / 'model/predictions.json')]
    assert {row.features.district for row in model_predictions} == {row.name for row in model_metadata.districts}
    assert len(model_predictions) == 140
    assert all(row.model_version == model_metadata.model_version for row in model_predictions)

    scenarios = ScenarioListResponse.model_validate(read(fixtures / "scenarios.json"))
    legacy_json = {fixtures / "scenarios.json"}
    for scenario in scenarios.data:
        path = fixtures / f"{scenario.id}.json"
        value = PlanningResponse.model_validate(read(path))
        if value.data.scenario != scenario or not value.meta.is_synthetic:
            raise ValueError(f"Legacy scenario identity/provenance differs: {path.relative_to(ROOT)}")
        legacy_json.add(path)
    if set(fixtures.glob("*.json")) != legacy_json:
        raise ValueError("Unexpected static JSON fixture without a schema assignment")

    geographic = ROOT / "contracts" / "geography"
    manifest = read(geographic / "manifest.json")
    if (manifest["geography_version"], manifest["is_synthetic"]) != (geography.geography_version, geography.is_synthetic):
        raise ValueError("Geographic manifest provenance differs from its API catalog")
    sources = [GeographySource.model_validate({key: value for key, value in source.items() if key in GeographySource.model_fields}) for source in manifest["sources"]]
    if sources != geography.sources:
        raise ValueError("Geographic manifest sources differ from validated API source schemas")
    descriptors = {layer["file"]: layer for layer in manifest["layers"]}
    for descriptor in geography.layers:
        manifest_layer = descriptors.get(Path(descriptor.asset_path).name)
        if not manifest_layer or (manifest_layer["id"], manifest_layer["source_id"], manifest_layer["geometry_types"], manifest_layer["feature_count"]) != (
            descriptor.id, descriptor.source_id, descriptor.geometry_types, descriptor.feature_count,
        ):
            raise ValueError("Geographic manifest layer differs from its validated API descriptor")
    paths = set(geographic.glob("*.geojson"))
    if paths != {geographic / name for name in descriptors}:
        raise ValueError("Every geographic asset must appear exactly once in its manifest")
    for path in sorted(paths | set(fixtures.rglob("*.geojson"))):
        layer = GeographyLayerCollection.model_validate(read(path))
        descriptor = descriptors.get(path.name) if path.parent == geographic else None
        if descriptor:
            if len(layer.features) != descriptor["feature_count"]:
                raise ValueError(f"Geographic feature count differs: {path.name}")
            if any(feature.geometry.type not in descriptor["geometry_types"] for feature in layer.features):
                raise ValueError(f"Undeclared geometry type: {path.name}")
            ids = [feature.id for feature in layer.features]
            if any(identifier is None for identifier in ids) or len(set(ids)) != len(ids):
                raise ValueError(f"Geographic IDs must be present and unique: {path.name}")
    print(f"Validated {len(expected_forecasts)} forecasts, metadata, geography, {len(legacy_json)} legacy JSON fixtures and {len(paths) + len(list(fixtures.rglob('*.geojson')))} GeoJSON assets")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, ValidationError) as error:
        raise SystemExit(f"Fixture schema validation failed: {error}") from error
