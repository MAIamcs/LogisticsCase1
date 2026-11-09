# API integration contract

The normative machine-readable contract is [`../contracts/openapi.json`](../contracts/openapi.json).
Author changes in `backend/app/models.py` and `backend/app/forecast_models.py`; regenerate OpenAPI, JSON Schemas and
TypeScript together. FastAPI exposes interactive documentation at `/docs` and
its live schema at `/openapi.json`. Paths below are relative to
`VITE_API_BASE_URL` (which does **not** include `/api/v1`).

## Forecast and geography API — schema 1.2

The stable model integration contract is documented in
[Forecast metadata, responses, missing values, aggregates and critical intervals](forecast-contract.md).

| Method / API path | Static demo file relative to Vite base | Response |
| --- | --- | --- |
| `GET /api/v1/geography` | `demo/forecast/geography.json` | `Geography` |
| `GET /api/v1/geography/layers/{layer_id}` | `geography/{layer_id}.geojson` | `GeographyLayerCollection` |
| `GET /api/v1/metadata` | `demo/forecast/metadata.json` | `ForecastMetadataResponse` |
| `GET /api/v1/forecast?year=2030&metric=population&scenario=baseline` | `demo/forecast/baseline/population/2030.json` | `ForecastResponse` |

These endpoints use top-level typed objects, identical in API and static demo
mode. They coexist with the corridor workspace's earlier `meta`/`data` envelope.
The forecast provider is replaceable without changing routes or response shapes.
Real geographic provenance (`geography_version`, `is_synthetic: false`, sources)
is separate from the currently synthetic statistical forecast (`is_demo: true`).
The source base year is 2026, with every year through 2030 declared by metadata.
See [geodata sources](geodata.md) for the ten actual district boundaries, road,
building, river and station assets and their individual terms.

## Existing corridor endpoints and demo equivalents

| Method / API path | Demo file relative to Vite base | Response |
| --- | --- | --- |
| `GET /api/v1/health` | Not requested in demo | `HealthResponse` |
| `GET /api/v1/scenarios` | `demo/scenarios.json` | `ScenarioListResponse` |
| `GET /api/v1/scenarios/{scenario_id}` | `demo/{scenario_id}.json` | `PlanningResponse` |

IDs currently are `morning` and `evening`; consumers must load the catalog,
not hardcode them. Scenario IDs match `^[a-z0-9-]+$` and are at most 80 characters.
Requests take no body and require no credentials. Responses are JSON.

Successful planning/catalog responses use:

```json
{
  "meta": {
    "schema_version": "1.0",
    "source": "synthetic",
    "is_synthetic": true,
    "disclaimer": "Synthetic demonstration data; not a forecast."
  },
  "data": {}
}
```

This envelope shows the structure only. `data` is the typed value below; an empty
object is not a valid planning or catalog response. Complete runnable examples
are in `contracts/fixtures/`. `source` is `synthetic` or `model`.
`is_synthetic` must equal `(source == "synthetic")`; the disclaimer is required
and nonempty. Demo responses must always be synthetic.

## Data types and semantics

`ScenarioListResponse.data` is an array of scenarios. Each has `id`, `name`,
`description`, `period` (human-readable label; not a request timestamp).

`PlanningResponse.data` contains:

| Field | Meaning |
| --- | --- |
| `scenario` | Full catalog scenario; its ID must match the requested ID |
| `summary.daily_trips` | Nonnegative integer, sum of fixture corridor trips per day |
| `summary.mean_travel_time_min` | Nonnegative number, simple mean across corridors, rounded to one decimal |
| `summary.mean_load_percent` | Number in 0–100, simple mean across corridors, rounded to one decimal |
| `corridors` | GeoJSON `FeatureCollection` of `LineString` features |

Each corridor feature has `type: "Feature"`, a string `id`, `geometry` and
`properties`. Feature `id` equals `properties.id`; IDs are unique within a
scenario and should be stable across comparable scenarios.

| Property | Type / units |
| --- | --- |
| `id`, `name` | Stable identifier and display label |
| `from_name`, `to_name` | Endpoint display labels |
| `load_percent` | Number in 0–100; synthetic utilization indicator in the fixtures |
| `travel_time_min` | Positive minutes |
| `length_km` | Positive kilometers |
| `daily_trips` | Nonnegative integer trips/day; synthetic, not unique people |

GeoJSON coordinates are WGS84/EPSG:4326, **[longitude, latitude]**, in decimal
degrees. A line has at least two positions. Longitude is within −180…180 and
latitude within −90…90. Geometry, trip counts and times in the supplied examples
are invented independently for UI development, not calibrated measurements.
The two hour-peak labels illustrate scenario switching; no inference about
actual peak-hour or daily demand may be drawn from them.

The map colors links at `<60`, `60–<80`, `>=80` percent. These are demonstration
display thresholds, not transport engineering standards. Empty catalogs and
empty corridor collections are valid and render empty states.

`HealthResponse` is an operational object, outside the data envelope:

```json
{"status":"ok","service":"transport-planning-api","model_status":"not_integrated"}
```

It does not assert that an analytical model is available.

## Errors and client behavior

```json
{"error":{"code":"not_found","message":"Scenario not found"}}
```

| Status | Code | Meaning |
| --- | --- | --- |
| 404 | `not_found` | Unknown route/scenario |
| 422 | `validation_error` | Invalid path/request parameters |
| 500 | `internal_error` | Server/adapter failure; no internal diagnostics in response |
| 503 | `service_unavailable` | Unavailable forecast provider or missing forecast fixture; not emitted by the corridor fixture adapter |

The frontend validates the success body against exported JSON Schemas, rejects
contradictory provenance, and shows a visible error for failed requests or invalid
configuration. Superseded requests are aborted; the timeout is 15 seconds.
It does not automatically retry or silently change data mode. Explicit refresh
or retry restarts the read flow. Error responses have no `meta` or `data` fields.

## Contract changes and model handoff

Update the contract, fixtures, validation tests and consumers in the same PR.
Incompatible field/semantic changes require a new API/schema version. The
initial v1 schema forbids unknown object properties; even additive changes need
coordinated regeneration and frontend deployment. Model adapters must return
the same Pydantic response objects, document metric definitions and limitations,
and preserve provenance. New calculations or long-running jobs require an
explicit contract extension rather than reusing this read-only API implicitly.
