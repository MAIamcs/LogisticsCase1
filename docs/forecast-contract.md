# Forecast contract — v1.2

The normative machine-readable definitions are `contracts/openapi.json`,
`contracts/schemas/forecast-metadata-response.json` and
`contracts/schemas/forecast-response.json`. Author changes in
`backend/app/forecast_models.py`, then export schemas and TypeScript. Typed contract objects forbid unknown fields; context-layer GeoJSON properties
are source-defined dictionaries. Incompatible changes require a new contract version.

## Requests and metadata

`GET /api/v1/metadata` returns `ForecastMetadataResponse`.
`GET /api/v1/forecast?year=2030&metric=population&scenario=baseline` returns
`ForecastResponse`. All three query parameters are required. `year` must be an
integer in metadata's available years; `metric` and `scenario` must be declared
IDs. IDs match `^[a-z][a-z0-9_-]*$` and are at most 80 characters. Unknown,
missing, malformed and extra parameters return HTTP 422 with field-specific
messages. Available choices come from the provider, not hardcoded API enums.

Metadata includes:

- `schema_version: "1.2"`, `data_version`, `is_demo` and a nonempty `disclaimer`;
- `base_year`: the source dataset's base year, **never the system date**;
- `available_years`: sorted, unique, starting with the base year;
- `metrics`: `id`, `name`, `unit`, `description`, `aggregation` (`sum` or `mean`), `semantic_type`, `geometry_types`;
- `scenarios`: `id`, `name`, `description`;
- `geography`: `crs: "EPSG:4326"`, `description`, `bbox`, `boundaries`, optional
  `reference_points`, independent `geography_version`, `is_synthetic`, `sources`, `layers`.

The demo's source base year is 2026; available years are every year 2026–2030
(inclusive): 2026, 2027, 2028, 2029, 2030. Metrics
are `population`, `transport_demand`, `infrastructure_load`; scenarios are
`baseline`, `compact`. None of these values are inferred from the clock.

`bbox` is `[west, south, east, north]`. Boundaries are a GeoJSON FeatureCollection
of Polygon/MultiPolygon zones, LineString/MultiLineString sections and, for applicable metrics, Points. Every feature has `id` equal to
`properties.feature_id`, and `properties.name`. Coordinates are
**[longitude, latitude]**, in degrees; polygon rings are closed. The API checks
coordinate ranges, closure and bounding-box containment, but does not perform
full topological validation of arbitrary model polygons. The current ten
Novosibirsk district geometries preserve vertices from the regional government
GIS district layer; they are not inferred from the supplied raster plan.
Source provenance and acquisition are documented in [geodata.md](geodata.md).

## Forecast response

Forecasts are top-level objects in both transports, not the legacy corridor
workspace's `meta`/`data` envelope. Required fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | `"1.2"` |
| `base_year`, `forecast_year` | Dataset base year and requested year |
| `metric`, `scenario` | Requested IDs |
| `model_version`, `data_version` | Provider/model and dataset versions |
| `is_demo`, `disclaimer` | Provenance; API mode still returns `is_demo: true` with the demo provider |
| `geojson` | GeoJSON FeatureCollection of all objects declared for the metric geometry types |
| `aggregates` | Totals/means and explicit observed coverage |
| `comparison` | Exactly two points, with roles `baseline` and `selected` |
| `critical_intervals` | Provider-authored review/intervention windows; may be empty |
| `warnings` | Structured data-quality warnings; may be empty for complete non-demo results |

Each forecast feature preserves the metadata boundary's ID, name and geometry.
`geometry_types` selects the applicable objects; every such object remains in
the response even with missing values. Other object types are reference context
and are never included in that metric's aggregates. `geography.reference_points`
is an optional FeatureCollection of real stops/stations with identity properties
only (`feature_id`, `name`, optional `source_id`), without invented metric values.
Forecast feature properties contain `feature_id`, `name`, `baseline_value`, `forecast_value`,
`delta_absolute`, `delta_percent`, `unit`, `quality_status`. All features remain
present when their values are missing. Numeric fields must be finite or null;
NaN and Infinity are rejected at the provider boundary.

```text
delta_absolute = forecast_value - baseline_value
delta_percent  = (forecast_value - baseline_value) / baseline_value * 100
```

If either operand is missing, **both deltas are null**. If the baseline is zero,
`delta_percent` is null; the absolute delta remains meaningful when both values
are observed. An observed zero is valid data. `quality_status` is `ok`,
`missing_baseline`, `missing_forecast` or `missing_both`; it is not inferred from
numeric truthiness. Derived values are rounded to six decimal places.

## Aggregates and comparison

`aggregates` includes `aggregation`, `unit`, `feature_count`,
`baseline_observed_count`, `forecast_observed_count`, `paired_observed_count`,
`coverage_comparable`, `baseline_value`, `forecast_value`, `delta_absolute`,
`delta_percent`.

- Each year's aggregate uses only that year's observed map values. A `sum`
  metric is their sum; a `mean` metric is their unweighted arithmetic mean.
  Empty observed sets produce **null**, not zero. Incomplete sums are partial
  observed totals and must not be represented as complete regional totals.
- Aggregate changes are available only when both years have the same nonempty
  set of observed feature IDs. Equal counts alone are insufficient. Otherwise,
  `coverage_comparable` is false and both aggregate deltas are null.
- Each comparison point contains `role`, `year`, `value`,
  `observed_feature_count`, `missing_feature_ids`. These values and coverage
  exactly match the map and aggregates. Selecting the base year still returns
  two explicitly labeled roles with that same year.

Population (`persons`) and transport demand (`trips/day`) use `sum`.
Infrastructure load (`%`) uses `mean`, can exceed 100%, and is **not** a share of
infrastructure to replace. Weighted aggregation is not currently supported; a
future weighted metric requires an explicit contract extension.

In the interface, absolute differences between percentage values are labeled
in percentage points (`п.п.`); relative percentage change remains labeled `%`.
The workspace loads every available year for one metric/scenario in one
validated series. The year scale uses the maximum-year response for the supplied
interval schedule, even when an earlier year is selected. The client only positions those intervals;
it does not create or infer them.

The current population demo has ten observed district values for every year,
with signed changes including decline. These statistical values remain invented
and are not official district population statistics. Tests separately inject
zero baselines and missing/different observed sets to verify null and coverage
semantics without displaying fictitious zero populations for real districts.

## Critical intervals and quality warnings

An interval has `start_year`, `end_year`, `severity` (`low`, `medium`, `high`,
`critical`), nonempty unique `affected_feature_ids`, `metric`,
`trigger_description`, `recommended_action`. Start must not exceed end; IDs
must exist in the response, and the metric must match the request. Intervals
intersect the inclusive `[base_year, forecast_year]` horizon. An ongoing interval
may start before the base year, and its full provider-supplied end is preserved
even when later than the requested year.

Intervals and recommendations come from the provider. The demo filters an
explicit versioned schedule by metric, scenario and horizon; it does **not**
derive intervention need from a load threshold. Neither API nor frontend
converts 100% load into a replacement percentage. The forecast client passes
intervals through unchanged.

Warnings contain `code`, `severity` (`info` or `warning`), `feature_ids` and
`message`. An empty ID list means a dataset-level warning. Demo warning codes
include `synthetic_data`, `missing_baseline`, `missing_forecast`, `zero_baseline`,
`incomparable_coverage`. Every feature with missing values must be covered by a
warning. Warning text is explanatory, not an intervention rule.

## Provider replacement and reproducibility

`ForecastProvider` is a Python Protocol with `is_demo`, `get_metadata()` and
`get_forecast(*, year, metric, scenario)`. `DemoForecastProvider` implements it
by reading the canonical static response files. Install a real provider through
`create_app(forecast_provider=...)` or override `get_forecast_provider` in tests.
No route or response shape changes are needed. The API validates selections
against that provider's metadata, revalidates payloads, and checks geography,
units, aggregation, requested identity and provenance before returning them.

`contracts/forecast-demo-source.json` is the versioned input for the deterministic
builder. It specifies base-year anchors, fixed annual changes, missing years
and explicit interval schedules. There is no randomness, timestamp or system
date. Base values, IDs and boundaries stay identical across scenarios and
years. All 30 parameter combinations plus metadata and geography are generated under
`contracts/fixtures/forecast/`, read directly by FastAPI, and copied by the
frontend build to `public/demo/forecast/`. CI rejects stale or extra fixtures.
Demo versions are `demo-linear-v3` and `synthetic-nsk-2026.1`. Full examples are
the generated JSON files, which are validated against the exported schemas.

## Errors and health

```json
{
  "error": {
    "code": "validation_error",
    "message": "Unknown year '2031'. Available values: 2026, 2027, 2028, 2029, 2030.",
    "details": [{"field": "year", "message": "Unknown year '2031'. Available values: 2026, 2027, 2028, 2029, 2030."}]
  }
}
```

HTTP 422 means invalid parameters, 503 / `service_unavailable` means unavailable
provider/missing demo files, and 500 / `internal_error` means invalid provider
output or an unexpected failure. Paths and diagnostics are logged, not returned.

`GET /api/v1/health` preserves its existing fields. It is a process liveness
check, not model/data readiness: `model_status` is `not_integrated` for demo,
`provider_configured` for an injected non-demo provider. It never claims a real
model is integrated when the demo provider is selected.

Request validation follows [FastAPI query parameter models](https://fastapi.tiangolo.com/tutorial/query-param-models/).
Finite numeric validation uses [Pydantic configuration](https://docs.pydantic.dev/latest/api/config/#pydantic.config.ConfigDict.allow_inf_nan).

## Version 1.1 geometry and semantics extension

This version adds line and point geometry, `semantic_type`, `geometry_types` and
optional `geography.reference_points`. Deploy backend, generated contracts and
frontend together; the legacy corridor API remains version 1.0. The endpoint
paths and ForecastProvider interface are unchanged.

Semantic types distinguish population, transport load, trip demand, passenger
flow, transport capacity and traffic intensity. They are not interchangeable.
Transport load uses a mean in percent and line geometry; summing these
percentages is rejected by Pydantic. The current demo uses ten real district polygons, a deterministic sample of
real named OSM road sections for synthetic transport metrics, and real mapped
rail/metro reference points where present. Declining population
and declining load are included intentionally to exercise both change scales.

## Version 1.2: real geography, annual horizon and geography API

`GET /api/v1/geography` returns `Geography` directly. Its static equivalent is
`demo/forecast/geography.json`; its body is identical to `metadata.geography`.
Geometry provenance is independent from forecast provenance: `is_synthetic`
is false for the imported geographic assets, while metadata/forecast `is_demo`
remains true until the analytical model supplies real statistical values.
`geography_version` identifies the geographic snapshot, separately from the
synthetic statistics `data_version` and provider `model_version`.

`sources` contains `id`, `name`, `url`, `attribution`, `license`, optional
`license_url`, and acquisition `retrieved_at`. District boundaries come from
regional government GIS; roads, building footprints, water and stations come
from OpenStreetMap. Their terms must be displayed separately. Absence of a
stated government GIS open licence is not represented as an OSM licence.

`layers` declares only context assets (`roads`, `buildings`, `water`, `stops`),
without duplicating the inline district boundaries. A descriptor has `id`,
`name`, `geometry_types`, `source_id` (a source catalog ID), `asset_path`, and
optional `feature_count`/`description`. `asset_path` is a relative frontend-root
path such as `geography/roads.geojson`, not an API base URL.

`GET /api/v1/geography/layers/{layer_id}` returns a typed GeoJSON
`FeatureCollection` of the real declared layer. In API mode clients use this
route; in static mode clients resolve `asset_path` against Vite `BASE_URL`.
Unknown layer IDs return a clear 404 listing available IDs; malformed path IDs
return 422; missing layer files return 503. Paths are allowlisted and may not
contain traversal or absolute paths. No endpoint accepts file paths from users.

The `GeographyProvider` interface (`get_layer(descriptor)`) is independent of
`ForecastProvider`. The default `LocalGeographyProvider` reads versioned files
from `contracts/geography/`; override `create_app(geography_provider=...)` for
another transport. Set `GEOGRAPHY_DATA_DIR` when deploying layers separately.
Replacing the analytical model does not require changing the frontend routes,
geometry contract or fixture generator.
