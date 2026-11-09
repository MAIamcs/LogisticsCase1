# Development

## Prerequisites and checkout

Use Node.js 22.12+ (CI uses 24), pnpm 11.25.0 and Python 3.11+ (CI uses 3.12).
Install pnpm through your Node toolchain. Work from the root of an existing
checkout, or clone into the requested local directory:

```sh
git clone https://github.com/MAIamcs/LogisticsCase1.git ~/Desktop/LogisticsCase
cd ~/Desktop/LogisticsCase
```

Skip cloning when a checkout already exists. An existing checkout or local alias
may use another directory name; verify `git rev-parse --show-toplevel` first.
See [CONTRIBUTING](../CONTRIBUTING.md) for the contribution and contract-review
procedure, and use the repository PR/issue templates.

## Frontend — standalone demo

```sh
cd frontend
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

Open the printed URL (normally `http://127.0.0.1:5173`). The example defaults to
`VITE_DATA_MODE=demo`; FastAPI is not needed. `predev` recreates generated,
ignored `public/demo/` from canonical fixtures and `public/geography/` from the
real GeoJSON/manifest in `contracts/geography/`. Edit canonical sources, not
these public copies. `prebuild` performs the same copy before production builds.

The current map uses ten district polygons from the regional government GIS and
OpenStreetMap roads, buildings, water and rail/metro stations. Statistical values
and critical intervals remain synthetic. There is no external tile dependency
or API key. Buildings are large, so they load only when enabled and zoom is at
least 12; other layers and numerical views remain independent.

## Geographic sources and reproduction

Read [source provenance and individual licences](geodata.md) before updating
geography. The government boundary source and OSM licence are separate. The
retained source snapshots reproduce the assets without a network connection:

```sh
python scripts/import_geography.py
python scripts/import_geography.py --check
```

The normal reproduction path uses Python's standard library. A deliberate new
OSM PBF import additionally needs the pinned tools described in `geodata.md`.
Update the snapshot version/date, source metadata, topology checks and attribution
together. Preserve all ten district contours, including separate Pashino, rather
than tracing the supplied raster plan. Then update references/versions in
`contracts/forecast-demo-source.json` and regenerate its responses. Source
snapshots stay in the repository; only GeoJSON and manifest ship to the browser.
`create_demo_fixtures.py` is only for the retained legacy corridor examples.

## Backend — separate process

Run from the repository root in another terminal:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements-dev.lock
python -m uvicorn app.main:app --app-dir backend --reload --host 127.0.0.1 --port 8000
```

The checked-in development lock records tested dependency versions; direct
runtime dependencies are also declared in `backend/pyproject.toml`. The backend
needs the checkout's `contracts/fixtures/` and `contracts/geography/` directories;
a standalone wheel does not package those files. For a separate host, deploy
this repository and run the command above from its root, using the host's
process manager and HTTPS proxy.
No backend hosting provider is prescribed by this scaffold.

Swagger is at `http://127.0.0.1:8000/docs`. The backend serves real geographic
layers and synthetic statistical fixtures. It never claims that the analytical
model is connected.

## Frontend — API mode

Set in `frontend/.env.local`, then restart Vite:

```dotenv
VITE_DATA_MODE=api
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_BASE_PATH=/
```

Use the absolute API base without `/api/v1`. A reverse-proxy path prefix is
allowed. There is no same-origin API proxy. The production API must use HTTPS
when called from GitHub Pages. Environment variables are embedded during the
frontend build, not read from FastAPI or changed at runtime.

The backend permits only local frontend origins by default. To enable the
published frontend, export this before starting FastAPI:

```sh
export CORS_ALLOW_ORIGINS='http://localhost:5173,http://127.0.0.1:5173,https://maiamcs.github.io'
```

Origins include scheme and port, but no path/trailing slash. Do not include
`/LogisticsCase1/` in CORS. Wildcard origins are rejected, including with
credentials. `CORS_ALLOW_CREDENTIALS` defaults to false; if a future integration
requires true, keep an explicit origin list. `backend/.env.example` is a
reference; Uvicorn does not load it automatically.

## Forecast API and future model

With the backend running:

```sh
curl http://127.0.0.1:8000/api/v1/metadata
curl http://127.0.0.1:8000/api/v1/geography
curl http://127.0.0.1:8000/api/v1/geography/layers/stops
curl 'http://127.0.0.1:8000/api/v1/forecast?year=2030&metric=population&scenario=baseline'
```

The default `DemoForecastProvider` serves reproducible synthetic statistical
values with real referenced geometry. Its base year is 2026, read from the source
data, and available years are 2026, 2027, 2028, 2029 and 2030. Metrics, years and
scenarios come from `/metadata`. See [the complete forecast contract](forecast-contract.md)
for nulls, units, aggregates, coverage and provider-authored critical intervals.
100% utilization does not imply any replacement percentage.

Regenerate forecasts after intentional changes to
`contracts/forecast-demo-source.json` or its referenced geographic assets:

```sh
python scripts/create_forecast_fixtures.py
python scripts/create_forecast_fixtures.py --check
```

Commit the source and all generated responses in `contracts/fixtures/forecast/`
together. There are 30 combinations, one metadata file and one geography file.
Static build copying includes these files; the API reads the same originals. The frontend transport
is `createForecastClient` in `frontend/src/data/forecast-client.ts`, using the
existing `VITE_DATA_MODE` and `VITE_API_BASE_URL`. It preserves nulls and model
intervals and never falls back from API errors to demo data. The current Russian
forecast workspace uses this transport; corridor endpoints and reusable code
remain available for compatibility.

The forecast/geography contract is version 1.2. Metric definitions declare
`semantic_type` and `geometry_types`; metadata includes polygon zones, line sections and optional
reference points. `GET /api/v1/geography` returns `metadata.geography` directly;
`GET /api/v1/geography/layers/{layer_id}` serves each declared real context layer.
Static equivalents are `demo/forecast/geography.json` and each descriptor's
`asset_path` under Vite `BASE_URL`. Geographic `geography_version`, sources and
`is_synthetic` are independent from statistical `data_version`, `model_version`
and `is_demo`. The client loads all metadata-declared years for the selected
metric/scenario, validates their identity and builds fixed change scales. A year
switch reuses those responses. See [map behavior and provider terms](map.md).

When deploying the backend outside the checkout, set `FORECAST_DEMO_DATA_DIR`
to an absolute directory containing that metadata and scenario/metric/year
tree. Set `GEOGRAPHY_DATA_DIR` independently to the directory containing real
layer GeoJSON files. Missing files return a retryable 503, not invented or
zero-filled data. Both examples are documented in `backend/.env.example`.

The model team implements `ForecastProvider` with `is_demo`, `get_metadata()`
and `get_forecast(*, year, metric, scenario)`, returning the documented Pydantic
types. Configure a future entry module as follows (the real adapter is not part
of this scaffold):

```python
from app.main import create_app
from my_model_adapter import ModelForecastProvider

app = create_app(forecast_provider=ModelForecastProvider())
```

Routes and response schemas stay unchanged. Tests may instead override
`get_forecast_provider`. Providers supply critical windows explicitly; they do
not rely on frontend color thresholds. Use `ForecastProviderUnavailable` for
temporary model failures, and accurate `is_demo`, data/model versions and
disclaimers. Health reports process liveness, not model readiness.

`GeographyProvider.get_layer(descriptor)` is a separate interface. The default
`LocalGeographyProvider` reads the versioned local assets. Inject another provider
through `create_app(geography_provider=...)` if geographic delivery changes;
analytical model replacement does not require geographic route changes.

## Contract generation and verification

From root, with the virtual environment active:

```sh
python scripts/export_contract.py
cd frontend
pnpm types:generate
pnpm exec tsc -b
pnpm test
pnpm build
cd ..
python scripts/export_contract.py --check
python scripts/import_geography.py --check
python scripts/create_forecast_fixtures.py --check
python -m pytest backend/tests -q
```

Commit `contracts/openapi.json`, `contracts/schemas/*.json`, generated TypeScript
and fixtures/geographic assets together. Never edit generated TypeScript manually.
After committing intentionally regenerated types, run
`git diff --exit-code -- contracts/api.generated.ts` from root after another
generation to detect drift. Frontend tests validate every advertised static
forecast combination against the exported JSON Schema.
Backend tests compare HTTP responses with canonical demo files, check CORS/errors/provenance
and verify adapter replacement. Frontend tests cover both transport URL paths,
runtime schemas, configuration and failures. CI also builds both data modes.

For a production preview under the actual Pages prefix:

```sh
cd frontend
VITE_DATA_MODE=demo VITE_BASE_PATH=/LogisticsCase1/ pnpm build
pnpm preview
```

Open the printed URL plus `/LogisticsCase1/`. Verify the compact sticky header
contains only the slider, every year 2026–2030 and model-supplied critical markers
on the same track. Parameter, district, refresh and layer controls belong beside
the map. Confirm all ten districts, including Pashino, use the actual contours.

Check district/section selection from map, select, ranking and table; object
card, numerical indicators, comparison columns and calendar-year dynamics must
follow the same ID. Reload the page to check persistence of a supported selected
object; IDs absent from the newly loaded catalog must be discarded.
Negative ranking changes extend left of zero. Missing observations break the
line and remain textual missing values. Verify fixed color domains between years,
absolute/percentage change, zero baselines, preserved camera, and the continuously
visible demo notice. Keyboard controls and narrow screens must remain usable.

Disable/re-enable each layer; zoom in with buildings enabled to verify their
lazy load, then check that a failed context layer leaves analytical layers and
numerical views present. No external tile host should be needed. For API smoke
testing, run/build with the separate local FastAPI service and verify configured
API requests for metadata, forecasts and geography layers. Stop the API and retry:
an error must appear with no silent switch to demo. Check WebGL fallback too.

## GitHub Pages

1. In repository **Settings → Pages → Build and deployment**, choose
   **GitHub Actions**. The workflow does not change repository settings itself.
2. Optional repository Actions variables: `VITE_DATA_MODE` (defaults to `demo`),
   `VITE_API_BASE_URL` (required HTTPS URL for `api`), `VITE_BASE_PATH` (defaults
   to `/<repository-name>/`, `/` for a user/organization Pages repository).
3. Merge a PR into `main` or run **Deploy frontend to GitHub Pages** manually on
   `main`. The workflow runs shared CI, builds static assets, uploads
   `frontend/dist/` and deploys the Pages artifact. Deployment permissions exist
   only in the deployment job. Pull requests run checks without deployment.
4. For this project the expected URL is
   `https://maiamcs.github.io/LogisticsCase1/` **after** successful deployment.
   The scaffold has not been pushed or published merely by adding the workflow.

Only static frontend files are uploaded. FastAPI never runs on GitHub Pages.
Keep all secrets out of `VITE_*` variables. For a custom domain/root path, set
`VITE_BASE_PATH=/` and configure that frontend origin in backend CORS. With no
production API yet, publish demo mode and retain all synthetic labels.

## Branches, PRs and responsibilities

- Keep `main` releasable. Use a focused branch; agent-created branches use
  `codex/<topic>`. Preserve existing team branches rather than renaming them.
- Inspect `git status` and applicable project instructions before editing.
  Preserve others' changes; do not reset, replace or force-push shared work.
- Open focused PRs into `main`. Describe the problem, resulting behavior,
  validation and any contract/deployment effects. Include screenshots for UI
  changes and both demo/API checks for data boundary changes.
- Request relevant reviewers; the team should enable required CI checks in
  branch protection. This scaffold does not configure repository protections.
- Commit frontend lockfile changes with dependency updates. Recreate the Python
  development lock intentionally in a clean environment and run all checks.

| Role | Responsibility / owned paths |
| --- | --- |
| Frontend developer | `frontend/`; map, accessibility, data client, both modes and Pages asset paths |
| Backend developer | `backend/`; forecast/geography routes and providers, Pydantic, CORS, errors, health and tests |
| Geographic-data maintainer | `contracts/geography/`, import script; source snapshots, ten district contours, stable geographic IDs, versions, completeness and individual licensing/attribution |
| Analytical-model developer | Future `ForecastProvider`; source base year, stable feature IDs, geography, units, missing values, aggregation, explicit critical intervals and provenance; `PlanningService` remains the corridor compatibility seam |
| Integration reviewer | `contracts/`, `docs/`, workflows; contract regeneration, mode parity and deployment configuration |

Roles are responsibilities, not assignments to named people. Review architecture
and contract changes together. Do not add new product features or analytical
claims as part of infrastructure changes without an agreed scope change.

Крупные `contracts/geography/roads.geojson` и `buildings.geojson` генерируются
из версионированного `source/osm-context.json.gz` и не хранятся повторно в Git.
Подготовка: `python3 scripts/import_geography.py` из корня. Frontend-команды
`pnpm dev`, `pnpm test` и `pnpm build` восстанавливают отсутствующие слои
автоматически; для этого нужен Python 3.11+. Содержимое GeoJSON и контрольные
суммы сохраняются без изменения.
