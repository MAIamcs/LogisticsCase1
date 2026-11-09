"""Run from repository root: PYTHONPATH=backend python scripts/export_contract.py [--check]."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.main import app
from app.models import PlanningResponse, ScenarioListResponse
from app.forecast_models import ForecastMetadataResponse, ForecastResponse, Geography, GeographyLayerCollection

parser = argparse.ArgumentParser()
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
artifacts = {
    "contracts/openapi.json": app.openapi(),
    "contracts/schemas/planning-response.json": PlanningResponse.model_json_schema(),
    "contracts/schemas/scenario-list-response.json": ScenarioListResponse.model_json_schema(),
    "contracts/schemas/forecast-metadata-response.json": ForecastMetadataResponse.model_json_schema(),
    "contracts/schemas/forecast-response.json": ForecastResponse.model_json_schema(),
    "contracts/schemas/geography-response.json": Geography.model_json_schema(),
    "contracts/schemas/geography-layer-response.json": GeographyLayerCollection.model_json_schema(),
}
for name, value in artifacts.items():
    target = ROOT / name
    content = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if not target.exists() or target.read_text(encoding="utf-8") != content:
            raise SystemExit(f"Stale contract: {name}. Run scripts/export_contract.py")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
print("Contracts are current" if args.check else "Contracts exported")
