import copy
import json
from itertools import product
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.demo_forecast import build_forecast, build_metadata
from app.forecast_models import CriticalInterval, ForecastResponse
from app.forecast_provider import DEFAULT_DEMO_DIRECTORY, DemoForecastProvider
from app.main import create_app
from app.settings import Settings

SOURCE = json.loads((DEFAULT_DEMO_DIRECTORY.parents[1] / "forecast-demo-source.json").read_text(encoding="utf-8"))
SELECTIONS = list(product(SOURCE["available_years"], [m["id"] for m in SOURCE["metrics"]], [s["id"] for s in SOURCE["scenarios"]]))


@pytest.fixture
def client():
    with TestClient(create_app(settings=Settings())) as client:
        yield client


def get_forecast(client, **overrides):
    return client.get("/api/v1/forecast", params={"year": 2030, "metric": "population", "scenario": "baseline", **overrides})


def test_metadata_uses_data_base_year_and_declares_geography(client):
    response = client.get("/api/v1/metadata")
    assert response.status_code == 200
    metadata = response.json()
    assert metadata == json.loads((DEFAULT_DEMO_DIRECTORY / "metadata.json").read_text())
    assert metadata["base_year"] == SOURCE["base_year"] == 2026
    assert metadata["available_years"] == list(range(2026, 2031))
    assert metadata["data_version"] == SOURCE["data_version"]
    assert metadata["is_demo"] is True
    assert all(set(metric) == {"id", "name", "unit", "description", "aggregation", "semantic_type", "geometry_types"} for metric in metadata["metrics"])
    assert metadata["geography"]["crs"] == "EPSG:4326"
    boundaries = metadata["geography"]["boundaries"]
    assert boundaries["type"] == "FeatureCollection"
    assert len({feature["id"] for feature in boundaries["features"]}) == len(SOURCE["features"])
    assert all(feature["id"] == feature["properties"]["feature_id"] for feature in boundaries["features"])


@pytest.mark.parametrize("year,metric,scenario", SELECTIONS)
def test_every_api_payload_equals_static_demo_and_reproduced_source(client, year, metric, scenario):
    response = get_forecast(client, year=year, metric=metric, scenario=scenario)
    assert response.status_code == 200
    fixture = json.loads((DEFAULT_DEMO_DIRECTORY / scenario / metric / f"{year}.json").read_text())
    assert response.json() == fixture
    assert build_forecast(SOURCE, year=year, metric=metric, scenario=scenario).model_dump(mode="json") == fixture
    assert (fixture["base_year"], fixture["forecast_year"], fixture["metric"], fixture["scenario"]) == (2026, year, metric, scenario)
    assert fixture["model_version"] == "demo-linear-v3"
    assert fixture["is_demo"] is True
    json.dumps(response.json(), allow_nan=False)  # No NaN/Infinity anywhere, including aggregates.


@pytest.mark.parametrize("year,metric,scenario", SELECTIONS)
def test_stable_ids_geometries_names_and_baselines_across_years_and_scenarios(client, year, metric, scenario):
    base = get_forecast(client, year=2026, metric=metric, scenario="baseline").json()
    selected = get_forecast(client, year=year, metric=metric, scenario=scenario).json()
    assert selected["data_version"] == base["data_version"]
    assert [f["id"] for f in selected["geojson"]["features"]] == [f["id"] for f in base["geojson"]["features"]]
    for feature, original in zip(selected["geojson"]["features"], base["geojson"]["features"], strict=True):
        assert feature["geometry"] == original["geometry"]
        assert feature["properties"]["name"] == original["properties"]["name"]
        assert feature["properties"]["baseline_value"] == original["properties"]["forecast_value"]


def population_items(source=SOURCE):
    return [f for f in source["features"] if "population" in f["anchor_values"]]


def test_values_match_versioned_anchors_and_annual_changes(client):
    data = get_forecast(client).json()
    properties = {f["id"]: f["properties"] for f in data["geojson"]["features"]}
    for item in population_items():
        feature = properties[item["feature_id"]]
        baseline = item["anchor_values"]["population"]
        forecast = baseline + item["annual_changes"]["population"] * (2030 - SOURCE["base_year"])
        assert feature["baseline_value"] == baseline
        assert feature["forecast_value"] == forecast
        assert feature["delta_absolute"] == forecast - baseline
        assert feature["delta_percent"] == pytest.approx((forecast - baseline) / baseline * 100, abs=1e-6)


def test_zero_baseline_preserves_observed_zero_and_null_percent():
    source = copy.deepcopy(SOURCE)
    item = population_items(source)[0]
    item["anchor_values"]["population"] = 0
    item["annual_changes"]["population"] = 125
    data = build_forecast(source, year=2030, metric="population", scenario="baseline")
    zero = next(f.properties for f in data.geojson.features if f.id == item["feature_id"])
    assert (zero.baseline_value, zero.forecast_value, zero.delta_absolute) == (0, 500, 500)
    assert zero.delta_percent is None
    assert zero.quality_status == "ok"
    base = build_forecast(source, year=2026, metric="population", scenario="baseline")
    zero = next(f.properties for f in base.geojson.features if f.id == item["feature_id"])
    assert zero.delta_absolute == 0 and zero.delta_percent is None


def test_missing_values_stay_null_and_have_quality_warnings():
    source = copy.deepcopy(SOURCE)
    first, second = population_items(source)[:2]
    first["missing_years"]["population"] = [2026]
    second["missing_years"]["population"] = [2030]
    data = build_forecast(source, year=2030, metric="population", scenario="baseline")
    features = {f.id: f.properties for f in data.geojson.features}
    assert features[first["feature_id"]].baseline_value is None
    assert features[first["feature_id"]].forecast_value is not None
    assert features[first["feature_id"]].quality_status == "missing_baseline"
    assert features[second["feature_id"]].baseline_value is not None
    assert features[second["feature_id"]].forecast_value is None
    assert features[second["feature_id"]].quality_status == "missing_forecast"
    for item in [first, second]:
        feature = features[item["feature_id"]]
        assert feature.delta_absolute is None and feature.delta_percent is None
        assert any(item["feature_id"] in warning.feature_ids for warning in data.warnings)
    base = build_forecast(source, year=2026, metric="population", scenario="baseline")
    assert next(f.properties for f in base.geojson.features if f.id == first["feature_id"]).quality_status == "missing_both"
    assert data.aggregates.coverage_comparable is False  # Equal counts can still hide different object sets.
    assert data.aggregates.delta_absolute is None and data.aggregates.delta_percent is None


@pytest.mark.parametrize("metric", [m["id"] for m in SOURCE["metrics"]])
def test_map_aggregates_and_comparison_are_consistent(client, metric):
    data = get_forecast(client, metric=metric).json()
    properties = [f["properties"] for f in data["geojson"]["features"]]
    aggregates = data["aggregates"]
    method = next(m["aggregation"] for m in SOURCE["metrics"] if m["id"] == metric)
    assert aggregates["feature_count"] == len(properties)
    for key, count_key, comparison in [
        ("baseline_value", "baseline_observed_count", data["comparison"][0]),
        ("forecast_value", "forecast_observed_count", data["comparison"][1]),
    ]:
        observed = [p[key] for p in properties if p[key] is not None]
        expected = round(sum(observed) / (len(observed) if method == "mean" else 1), 6)
        assert aggregates[key] == expected
        assert aggregates[count_key] == len(observed)
        assert comparison["value"] == expected
        assert comparison["observed_feature_count"] == len(observed)
        assert comparison["missing_feature_ids"] == sorted(p["feature_id"] for p in properties if p[key] is None)
    assert aggregates["coverage_comparable"] is True
    assert aggregates["delta_absolute"] == round(aggregates["forecast_value"] - aggregates["baseline_value"], 6)


def test_all_missing_does_not_aggregate_to_zero():
    source = copy.deepcopy(SOURCE)
    for feature in source["features"]:
        feature["missing_years"]["population"] = source["available_years"]
    result = build_forecast(source, year=2030, metric="population", scenario="baseline")
    assert result.aggregates.baseline_value is None
    assert result.aggregates.forecast_value is None
    assert result.aggregates.baseline_observed_count == 0
    assert result.aggregates.forecast_observed_count == 0
    assert result.aggregates.delta_absolute is None
    assert all(point.value is None for point in result.comparison)
    assert all(f.properties.quality_status == "missing_both" for f in result.geojson.features)


def test_zero_aggregate_baseline_has_null_percent_and_observed_coverage():
    source = copy.deepcopy(SOURCE)
    for feature in source["features"]:
        feature["anchor_values"]["population"] = 0
        feature["missing_years"]["population"] = []
    result = build_forecast(source, year=2030, metric="population", scenario="baseline")
    assert result.aggregates.baseline_value == 0
    assert result.aggregates.forecast_value > 0
    assert result.aggregates.delta_absolute == result.aggregates.forecast_value
    assert result.aggregates.delta_percent is None
    assert result.aggregates.baseline_observed_count == 10
    assert result.aggregates.coverage_comparable is True


@pytest.mark.parametrize("override,field,selected", [
    ({"metric": "employment"}, "metric", "employment"),
    ({"year": 2031}, "year", "2031"),
    ({"scenario": "unknown"}, "scenario", "unknown"),
])
def test_unknown_selection_has_clear_422_and_available_values(client, override, field, selected):
    response = get_forecast(client, **override)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert field in error["message"] and selected in error["message"]
    assert "Available values:" in error["message"]
    assert error["details"][0]["field"] == field


@pytest.mark.parametrize("params,field", [
    ({"metric": "population", "scenario": "baseline"}, "year"),
    ({"year": "2030.5", "metric": "population", "scenario": "baseline"}, "year"),
    ({"year": 2030, "metric": "../population", "scenario": "baseline"}, "metric"),
    ({"year": 2030, "metric": "population", "scenario": "baseline", "unexpected": "1"}, "unexpected"),
])
def test_invalid_query_is_validated_before_provider(client, params, field):
    response = client.get("/api/v1/forecast", params=params)
    assert response.status_code == 422
    assert field in response.json()["error"]["message"]


def test_critical_intervals_are_provider_authored_and_structured(client):
    data = get_forecast(client).json()
    assert len(data["critical_intervals"]) == 1
    expected = {k: v for k, v in SOURCE["critical_intervals"][0].items() if k != "scenario"}
    assert data["critical_intervals"][0] == expected
    interval = CriticalInterval.model_validate(expected)
    assert interval.start_year == 2028
    assert interval.end_year == 2029
    assert set(interval.affected_feature_ids) <= {f["id"] for f in data["geojson"]["features"]}
    assert get_forecast(client, year=2026).json()["critical_intervals"] == []


def test_load_at_and_above_100_does_not_generate_intervention_intervals():
    source = copy.deepcopy(SOURCE)
    source["critical_intervals"] = []
    section = next(item for item in source["features"] if "infrastructure_load" in item["anchor_values"])
    section["anchor_values"]["infrastructure_load"] = 100
    section["annual_changes"]["infrastructure_load"] = 2.25
    for year, expected in [(2026, 100), (2030, 109)]:
        data = build_forecast(source, year=year, metric="infrastructure_load", scenario="baseline")
        feature = next(f for f in data.geojson.features if f.id == section["feature_id"])
        assert feature.properties.forecast_value == expected
        assert data.critical_intervals == []


def test_provider_can_preserve_an_ongoing_interval_starting_before_base_year():
    source = copy.deepcopy(SOURCE)
    source["critical_intervals"][0].update(start_year=2020, end_year=2028)
    result = build_forecast(source, year=2030, metric="population", scenario="baseline")
    assert result.critical_intervals[0].start_year == 2020
    assert result.critical_intervals[0].end_year == 2028


@pytest.mark.parametrize("change", [
    {"delta_percent": float("inf")}, {"forecast_value": float("nan")},
    {"delta_absolute": 12345}, {"quality_status": "missing_baseline"},
])
def test_invalid_numeric_or_delta_values_are_rejected(change):
    data = DemoForecastProvider().get_forecast(year=2030, metric="transport_demand", scenario="baseline").model_dump()
    data["geojson"]["features"][0]["properties"].update(change)
    with pytest.raises(ValidationError):
        ForecastResponse.model_validate(data)


@pytest.mark.parametrize("change", [
    {"start_year": 2033, "end_year": 2029},
    {"affected_feature_ids": ["unknown-area"]},
    {"metric": "transport_demand"},
    {"recommended_action": ""},
])
def test_invalid_critical_intervals_are_rejected(change):
    data = DemoForecastProvider().get_forecast(year=2030, metric="population", scenario="baseline").model_dump()
    data["critical_intervals"][0].update(change)
    with pytest.raises(ValidationError):
        ForecastResponse.model_validate(data)


def test_future_provider_replacement_needs_no_api_changes():
    source = copy.deepcopy(SOURCE)
    source.update(base_year=2020, available_years=[2020, 2030, 2040], data_version="test-source-v2", model_version="test-provider-v2")

    class ReplacementProvider:
        is_demo = False

        def get_metadata(self):
            return build_metadata(source).model_copy(update={"is_demo": False, "disclaimer": "Test adapter output"})

        def get_forecast(self, **selection):
            return build_forecast(source, **selection).model_copy(update={"is_demo": False, "disclaimer": "Test adapter output"})

    with TestClient(create_app(settings=Settings(), forecast_provider=ReplacementProvider())) as client:
        assert client.get("/api/v1/metadata").json()["base_year"] == 2020
        result = get_forecast(client)
        assert result.status_code == 200
        assert result.json()["base_year"] == 2020
        assert result.json()["model_version"] == "test-provider-v2"
        assert result.json()["data_version"] == "test-source-v2"
        assert result.json()["is_demo"] is False
        assert client.get("/api/v1/health").json()["model_status"] == "provider_configured"


def test_unavailable_provider_returns_retryable_error_without_path_leak(tmp_path):
    with TestClient(create_app(settings=Settings(forecast_demo_data_dir=tmp_path))) as client:
        response = get_forecast(client)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "service_unavailable"
        assert str(tmp_path) not in response.text
        assert client.get("/api/v1/health").status_code == 200


def test_corrupted_aggregate_is_rejected_at_provider_boundary():
    class CorruptProvider(DemoForecastProvider):
        def get_forecast(self, **selection):
            response = super().get_forecast(**selection)
            response.aggregates.forecast_value = 999
            return response

    with TestClient(create_app(settings=Settings(), forecast_provider=CorruptProvider()), raise_server_exceptions=False) as client:
        response = client.get("/api/v1/forecast", params={"year": 2030, "metric": "population", "scenario": "baseline"}, headers={"Origin": "http://localhost:5173"})
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "internal_error"
        assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_environment_cors_configuration(monkeypatch):
    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "https://planner.example.test")
    monkeypatch.setenv("CORS_ALLOW_CREDENTIALS", "true")
    with TestClient(create_app()) as client:
        response = client.get("/api/v1/metadata", headers={"Origin": "https://planner.example.test"})
        assert response.headers["access-control-allow-origin"] == "https://planner.example.test"
        assert response.headers["access-control-allow-credentials"] == "true"
        denied = client.get("/api/v1/metadata", headers={"Origin": "https://unknown.example.test"})
        assert "access-control-allow-origin" not in denied.headers


@pytest.mark.parametrize("credentials", [True, False])
def test_cors_wildcard_is_rejected(credentials):
    with pytest.raises(ValueError, match="explicit origins"):
        Settings(cors_allow_origins=("*",), cors_allow_credentials=credentials)


@pytest.mark.parametrize("origin", ["https://example.test/", "https://example.test/path", "file://example.test", "https://user:pass@example.test"])
def test_invalid_cors_origins_are_rejected(origin):
    with pytest.raises(ValueError, match="Invalid CORS origin"):
        Settings(cors_allow_origins=(origin,))


def test_metric_geometry_semantics_and_reference_stops(client):
    metadata = client.get('/api/v1/metadata').json()
    assert metadata['schema_version'] == '1.2'
    assert {'Polygon', 'MultiPolygon'} <= {f['geometry']['type'] for f in metadata['geography']['boundaries']['features']}
    assert metadata['geography']['is_synthetic'] is False
    assert metadata['geography']['geography_version']
    for metric in metadata['metrics']:
        data = get_forecast(client, metric=metric['id']).json()
        assert {f['geometry']['type'] for f in data['geojson']['features']} <= set(metric['geometry_types'])
        assert not {f['id'] for f in metadata['geography']['reference_points']['features']} & {f['id'] for f in data['geojson']['features']}
    districts = [f for f in metadata['geography']['boundaries']['features'] if f['id'].startswith('district-')]
    assert len(districts) == 10
    assert next(f for f in districts if f['id'] == 'district-kalininsky')['geometry']['type'] == 'MultiPolygon'


def test_provider_rejects_summing_load_percentages():
    from app.forecast_models import MetricDefinition
    metric = next(m for m in SOURCE['metrics'] if m['id'] == 'infrastructure_load')
    with pytest.raises(ValidationError, match='never a sum'):
        MetricDefinition.model_validate({**metric, 'aggregation': 'sum'})


def test_reference_stops_are_optional_and_do_not_change_forecasts():
    source = copy.deepcopy(SOURCE)
    source.pop('reference_points', None)
    source.pop('reference_points_asset', None)
    assert build_metadata(source).geography.reference_points.features == []
    assert build_forecast(source, year=2030, metric='population', scenario='baseline') == build_forecast(SOURCE, year=2030, metric='population', scenario='baseline')


def test_decreasing_population_remains_signed_data(client):
    data = get_forecast(client).json()
    source = next(item for item in population_items() if item['annual_changes']['population'] < 0)
    feature = next(f for f in data['geojson']['features'] if f['id'] == source['feature_id'])
    assert feature['properties']['delta_absolute'] == source['annual_changes']['population'] * 4
    assert feature['properties']['delta_percent'] < 0


def test_real_geography_endpoint_equals_metadata_and_static_manifest(client):
    metadata = client.get('/api/v1/metadata').json()
    response = client.get('/api/v1/geography')
    assert response.status_code == 200
    assert response.json() == metadata['geography']
    assert response.json() == json.loads((DEFAULT_DEMO_DIRECTORY / 'geography.json').read_text())
    assert response.json()['is_synthetic'] is False
    assert metadata['is_demo'] is True  # Synthetic statistics and real geometry have separate provenance.
    assert response.json()['geography_version'] != metadata['data_version']


@pytest.mark.parametrize('layer_id', ['roads', 'buildings', 'water', 'stops'])
def test_geographic_layer_matches_static_geojson(client, layer_id):
    geography = client.get('/api/v1/geography').json()
    layer = next(layer for layer in geography['layers'] if layer['id'] == layer_id)
    result = client.get(f'/api/v1/geography/layers/{layer_id}')
    assert result.status_code == 200
    path = DEFAULT_DEMO_DIRECTORY.parents[1] / layer['asset_path']
    expected = json.loads(path.read_text())
    assert result.json() == expected
    assert all(feature['geometry']['type'] in layer['geometry_types'] for feature in result.json()['features'])


def test_unknown_geographic_layer_has_clear_404(client):
    response = client.get('/api/v1/geography/layers/unknown')
    assert response.status_code == 404
    assert 'Available layers:' in response.json()['error']['message']


def test_unavailable_geographic_layer_returns_503(tmp_path):
    with TestClient(create_app(settings=Settings(geography_data_dir=tmp_path))) as client:
        response = client.get('/api/v1/geography/layers/buildings')
        assert response.status_code == 503
        assert str(tmp_path) not in response.text


def test_geographic_asset_traversal_is_rejected():
    from app.forecast_models import GeographyLayer
    for path in ['../outside.geojson', '/outside.geojson', 'geography\\outside.geojson']:
        with pytest.raises(ValidationError, match='relative GeoJSON'):
            GeographyLayer(id='test', name='Test', geometry_types=['Point'], source_id='osm', asset_path=path)
