# Existing CatBoost model: local inference

The application can run the supplied `catboost_congestion.cbm` without training
or executing `analyzer.ipynb`. The model predicts `congestion_index_0_10`, a
congestion index in points (`балл`). It does not predict Yandex travel time,
minutes of delay, speed, population, or infrastructure utilization. The existing
demo forecasts for 2026–2030 are a separate synthetic dataset.

## Install and start locally

Use Python 3.12 for the tested model environment. Install the ordinary backend
dependencies and the optional model dependencies in the **same** virtual
environment. From the repository root on macOS/Linux:

```sh
python3.12 -m venv .venv-model
source .venv-model/bin/activate
python -m pip install -r backend/requirements-dev.lock
python -m pip install -r backend/requirements-model.lock
python -m uvicorn app.main:app --app-dir backend --reload --host 127.0.0.1 --port 8000
```

On Windows PowerShell, create and activate the environment with:

```powershell
py -3.12 -m venv .venv-model
.\.venv-model\Scripts\Activate.ps1
python -m pip install -r backend/requirements-dev.lock
python -m pip install -r backend/requirements-model.lock
python -m uvicorn app.main:app --app-dir backend --reload --host 127.0.0.1 --port 8000
```

The default artifact is `backend/models/catboost_congestion.cbm`; its provenance
is recorded in `backend/models/manifest.json`. To select another local file,
set `CATBOOST_MODEL_PATH` before starting the backend, or use the CLI's `--model`
option. Do not rename a different trained model into this contract: the runtime
checks the feature names and categorical feature indices.

In another terminal, configure `frontend/.env.local` and start Vite:

```dotenv
VITE_DATA_MODE=api
VITE_API_BASE_URL=http://127.0.0.1:8000
```

```sh
cd frontend
pnpm dev
```

The model view requires API mode and the separate running FastAPI service.
GitHub Pages can host the static frontend; these local commands do not deploy
a public backend. A frontend opened on another computer cannot reach this
computer's API through its own `127.0.0.1`.

## Required input

Every prediction requires all seven raw fields. The API and CLI share
`ModelFeatures` validation. No population, lane count, or other district default
is inferred from the geographic boundaries or synthetic forecast fixtures.

| Field | Meaning |
| --- | --- |
| `hour` | Integer hour, 0–23; `08:00` is not an accepted API/CLI hour. |
| `district` | District category, using the Russian district name. |
| `is_main_road` | Numeric main-road flag, 0 or 1. |
| `day_of_week` | Russian weekday name, for example `Понедельник`. |
| `season` | Nonempty season category string. Preserve the source spelling. |
| `lanes_total` | Explicit integer total lane count, at least 1. |
| `population` | Explicit nonnegative integer population input for the selected configuration. |

`Лето` and `Не лето` are suggested season spellings for manual entry; they
have not been verified against the missing source CSV. A model can accept an
unseen category without proving that the category was present during training.

The adapter retains those fields and adds `hour_sin`, `hour_cos`, `dow_sin`, and
`dow_cos`, matching the notebook's cyclic transformations. Categorical indices
are `[1, 3, 4]` in the verified 11-feature model. In particular,
`is_main_road` is numeric. The training preprocessing medians were not saved;
missing or non-finite numerical inputs are rejected rather than imputed.
Integer inputs are limited to JavaScript's maximum safe integer
`9007199254740991` for consistent JSON exchange; this is not a learned feature
range. The actual population/lane training ranges are not recoverable without
the source CSV and are not claimed to have been validated.

The following complete example is **illustrative only**. Its population, lanes,
road flag and season are not recovered training values or district defaults.
Save it as `inputs.json` for a CLI smoke check, then replace every value with
the configuration you intend to assess:

```json
{
  "hour": 8,
  "district": "Центральный",
  "is_main_road": 1,
  "day_of_week": "Понедельник",
  "season": "Лето",
  "lanes_total": 4,
  "population": 100000
}
```

## REST interface

Read model identity, readiness and limitations with
`GET /api/v1/model/metadata`. Swagger is available at
`http://127.0.0.1:8000/docs` while the local backend is running.

```sh
curl http://127.0.0.1:8000/api/v1/model/metadata
curl -X POST http://127.0.0.1:8000/api/v1/model/predict \
  -H 'Content-Type: application/json' \
  --data '{"features":{"hour":8,"district":"Центральный","is_main_road":1,"day_of_week":"Понедельник","season":"Лето","lanes_total":4,"population":100000},"include_hourly_profile":true}'
```

The POST body contains `features` and optional `include_hourly_profile`.
The response contract contains `schema_version: "1.0"`, `model_version`,
`target`, the validated `features`, `feature_id`, `prediction`,
`hourly_profile`, and `warnings`. `prediction` contains the raw scalar `value`,
`unit: "балл"`, and `out_of_expected_range`. The regressor's result is preserved,
including any value outside the target's nominal 0–10 range.

Requesting the hourly profile evaluates hours 0–23 while holding the other six
inputs fixed. Each point is `{ "hour": ..., "value": ... }`. This profile
describes a specified configuration; it is not a sequence of live observations.
The model response does not supply a confidence interval or a critical period.

## Batch CLI

Run the CLI in the same activated model environment. It accepts a JSON object,
a JSON array of objects, or a UTF-8 CSV containing exactly the seven input
columns. CSV numbers are parsed before the shared schema is applied; category
strings preserve their spelling.

```sh
python scripts/predict_congestion.py --input inputs.json
python scripts/predict_congestion.py --input inputs.json --output predictions.json --hourly
python scripts/predict_congestion.py --input inputs.csv --output predictions.csv
python scripts/predict_congestion.py --input inputs.json --model /absolute/path/catboost_congestion.cbm
```

JSON output is always an array of full API-shaped prediction responses, even
for a single input row. Without `--output`, that JSON array goes to stdout.
The destination extension selects JSON or CSV. CSV has the seven input fields
followed by `prediction`, `model_version`, and `unit`; use JSON when you need
warnings or the range flag. `--hourly` requires JSON output so that the profile
is preserved.

All rows are validated before model loading or prediction. A bad row fails the
whole batch. Predictions are completed and serialized before an output file is
atomically replaced; a validation or inference failure leaves an existing output
file untouched. The output directory must already exist, and the destination
must differ from the input file. Errors go to stderr with exit status 2.

## Inference verification

The supplied binary was checked on Python 3.12 with CatBoost 1.2.10 using
5,040 completely specified synthetic configurations: all 24 hours, ten district
labels, seven weekdays and three explicit season strings (`Лето`, `Не лето`,
`Зима`), with population 100000, four lanes and main-road flag 1. These are test
inputs, not recovered training profiles or application defaults; the season
strings remain unverified training categories.

The adapter's `math.sin/cos` features matched an independent reconstruction of
the notebook's NumPy transformations exactly in this environment. Both feature
matrices produced identical predictions from the actual CBM (maximum absolute
difference 0). Thirty-two concurrent hourly requests over eight threads also
returned identical responses and model identity for the same configuration.
Separate checks cover JSON/CSV prediction agreement, selected-hour/profile
agreement, complete-batch validation, and output preservation on failure.

These checks verify inference integration and consistency. They do not measure
accuracy against independent traffic observations or validate future forecasts.

## Provenance and scope

The supplied binary contains 1,499 trees, was trained with CatBoost 1.2.10, and
records a training finish time of `2026-11-10T19:10:46Z`. Its SHA-256 is
`4ccc8aa44af40c96784eed35e5b7516835172795da366bd889f0531317030706`.

The notebook reports 3,360 cleaned rows, MAE 0.159199, RMSE 0.219081 and
R² 0.991915 on a 20% random/stratified split. The binary independently contains
the best held-out RMSE of 0.2190812584. These are results of the supplied training
run, not newly reproduced accuracy estimates. They do not establish long-term
forecast accuracy or causal effects from changing population or lanes.

`novosibirsk_ml_dataset_final_8columns.csv` was not supplied with the available
artifacts. The notebook does not print the district input configurations, and
the CBM's split thresholds and category hashes do not recover those original
rows. A district-wide forecast therefore needs sourced configurations first.

There is no year or scenario identifier among the trained inputs. Identical
seven-field inputs produce identical results regardless of a year selection.
Changing an input can be explored as a sensitivity calculation; it does not
validate a future-year or policy-effect forecast. Model inference does not
replace the demo population, demand, utilization or critical-interval providers.
Neither the API nor CLI trains a model or runs the notebook.
