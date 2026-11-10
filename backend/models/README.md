# Supplied congestion model

`catboost_congestion.cbm` is the existing trained CatBoost regression artifact.
`manifest.json` records its identity and provenance. The runtime loads it for
inference only; it does not train or execute the source notebook.

- Target: `congestion_index_0_10`, measured in points (`балл`), not travel time.
- Binary SHA-256: `4ccc8aa44af40c96784eed35e5b7516835172795da366bd889f0531317030706`.
- CatBoost training version: 1.2.10; retained trees: 1,499.
- Eleven input features include the seven required raw fields and four cyclic
  hour/weekday transformations. Categorical feature indices are `[1, 3, 4]`.
- The training CSV and numeric preprocessing medians are unavailable. Do not
  invent district population/lane profiles or fill missing model inputs.

The default path is this directory's `catboost_congestion.cbm`.
`CATBOOST_MODEL_PATH` selects another local CBM for the backend; CLI `--model`
overrides it. A replacement must satisfy the verified feature contract.

Install optional dependencies from `backend/requirements-model.lock` in the
same environment as the backend dependencies. See
[local setup, REST, batch CLI and limitations](../../docs/model-integration.md).
No year, future horizon, scenario identifier, confidence interval or critical
period is part of this model's trained contract.
