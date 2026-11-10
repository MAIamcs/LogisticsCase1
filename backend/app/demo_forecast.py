"""Deterministic versioned fixture builder, not an analytical or intervention model."""
import json
from functools import lru_cache
from pathlib import Path
from .forecast_models import (
    CriticalInterval, DataQualityWarning, ForecastFeature, ForecastFeatureCollection,
    ForecastMetadataResponse, ForecastProperties, ForecastResponse, changes, quality_status, summarize,
)

GEOGRAPHY_DIRECTORY = Path(__file__).resolve().parents[2] / "contracts" / "geography"


@lru_cache(maxsize=16)
def _geographic_asset(path: Path, modified_at: int):
    return json.loads(path.read_text(encoding="utf-8"))["features"]


def geographic_features(filename: str):
    path = GEOGRAPHY_DIRECTORY / filename
    return _geographic_asset(path, path.stat().st_mtime_ns)


def boundary_record(feature: dict):
    props = feature["properties"]
    id_ = props.get("feature_id") or feature.get("id")
    return {
        "type": "Feature", "id": id_, "geometry": feature["geometry"],
        "properties": {"feature_id": id_, "name": props["name"], "source_id": props.get("source_id")},
    }


def build_metadata(source: dict) -> ForecastMetadataResponse:
    boundaries = []
    geography = source.get("geography", {})
    catalog = {
        feature["properties"].get("feature_id", feature.get("id")): feature
        for filename in source.get("geography_assets", []) for feature in geographic_features(filename)
    }
    for item in source["features"]:
        if "geometry_id" in item:
            record = boundary_record(catalog[item["geometry_id"]])
            if record['geometry']['type'] in {'LineString', 'MultiLineString'}:
                pieces = []
                for road in geographic_features('roads.geojson'):
                    if road['properties'].get('name') == item['name']:
                        geometry = road['geometry']
                        if geometry['type'] == 'LineString': pieces.append(geometry['coordinates'])
                        elif geometry['type'] == 'MultiLineString': pieces.extend(geometry['coordinates'])
                if pieces: record['geometry'] = {'type': 'MultiLineString', 'coordinates': pieces}
            if record["id"] != item["feature_id"] or record["properties"]["name"] != item["name"]:
                raise ValueError("Statistical feature identity must match the versioned real geography")
            boundaries.append(record)
            continue
        elif "geometry" in item:
            geometry = item["geometry"]
        else:
            west, south, east, north = item["bbox"]
            geometry = {"type": "Polygon", "coordinates": [[
                [west, south], [east, south], [east, north], [west, north], [west, south],
            ]]}
        boundaries.append({
            "type": "Feature", "id": item["feature_id"],
            "properties": {"feature_id": item["feature_id"], "name": item["name"], "source_id": item.get("source_id")},
            "geometry": geometry,
        })
    from .forecast_models import BoundaryFeature, positions
    points = [boundary_record(feature) for feature in geographic_features(source["reference_points_asset"])] if source.get("reference_points_asset") else source.get("reference_points", [])
    coordinates = [position for feature in boundaries + points for position in positions(BoundaryFeature.model_validate(feature).geometry)]
    return ForecastMetadataResponse.model_validate({
        "schema_version": "1.2", "base_year": source["base_year"],
        "available_years": source["available_years"], "data_version": source["data_version"],
        "is_demo": True, "disclaimer": source["disclaimer"], "metrics": source["metrics"],
        "scenarios": [{k: v for k, v in scenario.items() if k != "rate_factor"} for scenario in source["scenarios"]],
        "geography": {
            "crs": "EPSG:4326", "description": geography.get("description", "Географические объекты поставщика данных."),
            "geography_version": geography.get("geography_version", "unspecified"),
            "is_synthetic": geography.get("is_synthetic", True),
            "sources": geography.get("sources", []), "layers": geography.get("layers", []),
            "bbox": [min(p[0] for p in coordinates), min(p[1] for p in coordinates), max(p[0] for p in coordinates), max(p[1] for p in coordinates)],
            "boundaries": {"type": "FeatureCollection", "features": boundaries},
            "reference_points": {"type": "FeatureCollection", "features": points},
        },
    })


def build_forecast(source: dict, *, year: int, metric: str, scenario: str) -> ForecastResponse:
    metadata = build_metadata(source)
    definition = next(item for item in metadata.metrics if item.id == metric)
    factor = next(item["rate_factor"] for item in source["scenarios"] if item["id"] == scenario)
    if year not in metadata.available_years:
        raise ValueError("Year is not present in the source data")
    features = []
    for item, boundary in zip(source["features"], metadata.geography.boundaries.features, strict=True):
        if boundary.geometry.type not in definition.geometry_types:
            continue
        missing = item["missing_years"].get(metric, [])

        def value(at_year):
            if at_year in missing:
                return None
            return round(item["anchor_values"][metric] + item["annual_changes"][metric] * (at_year - metadata.base_year) * factor, 6)

        baseline, forecast = value(metadata.base_year), value(year)
        absolute, percent = changes(baseline, forecast)
        features.append(ForecastFeature(
            type="Feature", id=boundary.id, geometry=boundary.geometry,
            properties=ForecastProperties(
                feature_id=boundary.id, name=boundary.properties.name, unit=definition.unit,
                source_id=boundary.properties.source_id,
                baseline_value=baseline, forecast_value=forecast, delta_absolute=absolute, delta_percent=percent,
                quality_status=quality_status(baseline, forecast),
            ),
        ))
    geojson = ForecastFeatureCollection(type="FeatureCollection", features=features)
    aggregates, comparison = summarize(geojson, definition.unit, definition.aggregation, metadata.base_year, year)
    warnings = [DataQualityWarning(code="synthetic_data", severity="info", feature_ids=[], message=source["disclaimer"])]
    for code, ids, message in [
        ("missing_baseline", [f.id for f in features if f.properties.baseline_value is None], "Отсутствуют наблюдения за базовый год. Пропуск не равен нулю."),
        ("missing_forecast", [f.id for f in features if f.properties.forecast_value is None], "Отсутствуют значения за выбранный год. Пропуск не равен нулю."),
        ("zero_baseline", [f.id for f in features if f.properties.baseline_value == 0], "При нулевом базовом значении изменение в процентах не определено и возвращается как пропуск."),
    ]:
        if ids:
            warnings.append(DataQualityWarning(code=code, severity="warning", feature_ids=ids, message=message))
    if not aggregates.coverage_comparable:
        warnings.append(DataQualityWarning(
            code="incomparable_coverage", severity="warning", feature_ids=[],
            message="Состав наблюдаемых территорий различается или пуст. Общее изменение не определяется; итоги за каждый год учитывают только известные значения.",
        ))
    # Only filter an explicit provider-authored schedule by metric, scenario and
    # horizon. Never infer intervals or replacement shares from load thresholds.
    intervals = [
        CriticalInterval.model_validate({k: v for k, v in item.items() if k != "scenario"})
        for item in source["critical_intervals"]
        if item["metric"] == metric and item["scenario"] == scenario
        and item["start_year"] <= year and item["end_year"] >= metadata.base_year
    ]
    return ForecastResponse(
        schema_version="1.2", base_year=metadata.base_year, forecast_year=year,
        metric=metric, scenario=scenario, model_version=source["model_version"],
        data_version=metadata.data_version, is_demo=True, disclaimer=source["disclaimer"],
        geojson=geojson, aggregates=aggregates, comparison=comparison,
        critical_intervals=intervals, warnings=warnings,
    )
