"""Reproduce every static/API forecast payload from one versioned source file."""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.demo_forecast import build_forecast, build_metadata


def artifacts(source: dict):
    metadata = build_metadata(source)
    yield "metadata.json", metadata
    yield "geography.json", metadata.geography
    for scenario in metadata.scenarios:
        for metric in metadata.metrics:
            for year in metadata.available_years:
                yield f"{scenario.id}/{metric.id}/{year}.json", build_forecast(source, year=year, metric=metric.id, scenario=scenario.id)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    source = json.loads((ROOT / "contracts/forecast-demo-source.json").read_text(encoding="utf-8"))
    target = ROOT / "contracts/fixtures/forecast"
    expected = set()
    for name, model in artifacts(source):
        expected.add(name)
        path = target / name
        content = json.dumps(model.model_dump(mode="json"), indent=2, ensure_ascii=False, allow_nan=False) + "\n"
        if args.check:
            if not path.exists() or path.read_text(encoding="utf-8") != content:
                raise SystemExit(f"Stale forecast fixture: {name}. Run scripts/create_forecast_fixtures.py")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
    extra = {str(path.relative_to(target)) for path in target.rglob("*.json")} - expected
    if extra:
        if args.check:
            raise SystemExit(f"Unexpected forecast fixtures: {sorted(extra)}")
        # The annual source horizon intentionally supersedes previous generated
        # years. Remove only recognizable demo response files in this generated
        # tree; unfamiliar JSON is preserved and requires review.
        for name in sorted(extra):
            path = target / name
            parts = Path(name).parts
            value = json.loads(path.read_text(encoding="utf-8"))
            generated = len(parts) == 3 and path.stem.isdigit() and value.get("is_demo") is True \
                and value.get("scenario") == parts[0] and value.get("metric") == parts[1] \
                and str(value.get("forecast_year")) == path.stem
            if not generated:
                raise SystemExit(f"Unrecognized file preserved; review deliberately: {name}")
            path.unlink()
        print(f"Removed {len(extra)} superseded generated forecast files")
    print("Forecast fixtures are current" if args.check else "Forecast fixtures generated")


if __name__ == "__main__":
    main()
