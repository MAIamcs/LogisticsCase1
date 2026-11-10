"""Run inference with the existing CatBoost model, without training it.

From the repository root:
  python scripts/predict_congestion.py --input inputs.json --output predictions.json
"""
from __future__ import annotations

import argparse
import csv
from decimal import Decimal, InvalidOperation
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.model_schemas import ModelFeatures

RAW_FIELDS = (
    "hour", "district", "is_main_road", "day_of_week", "season", "lanes_total", "population",
)
NUMERIC_FIELDS = ("hour", "is_main_road", "lanes_total", "population")
DEFAULT_MODEL_PATH = ROOT / "backend" / "models" / "catboost_congestion.cbm"
CSV_OUTPUT_FIELDS = (*RAW_FIELDS, "prediction", "model_version", "unit")


class InputError(ValueError):
    """An input file or command option cannot produce a valid batch."""


def reject_json_constant(value: str) -> None:
    raise InputError(f"Non-finite JSON number is not allowed: {value}")


def csv_numbers(row: dict[str, Any], row_number: int) -> dict[str, Any]:
    """Convert CSV's textual numeric cells; categories keep their exact spelling."""
    converted = dict(row)
    for field in NUMERIC_FIELDS:
        raw = row.get(field)
        try:
            number = Decimal(raw)
        except (TypeError, ValueError, InvalidOperation) as error:
            raise InputError(f"CSV row {row_number}: {field} must contain a number") from error
        if not number.is_finite():
            raise InputError(f"CSV row {row_number}: {field} must be finite")
        converted[field] = int(number) if number == number.to_integral_value() else float(number)
    return converted


def load_input_rows(path: Path) -> list[ModelFeatures]:
    """Parse and validate the complete batch before loading or calling a model."""
    suffix = path.suffix.lower()
    if suffix == ".json":
        with path.open(encoding="utf-8-sig") as source:
            data = json.load(source, parse_constant=reject_json_constant)
        rows = data if isinstance(data, list) else [data]
    elif suffix == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as source:
            reader = csv.DictReader(source)
            headers = reader.fieldnames or []
            if len(headers) != len(set(headers)):
                raise InputError("CSV header contains duplicate columns")
            if set(headers) != set(RAW_FIELDS):
                missing = sorted(set(RAW_FIELDS) - set(headers))
                extra = sorted(set(headers) - set(RAW_FIELDS))
                raise InputError(f"CSV requires exactly seven input columns; missing={missing}, extra={extra}")
            rows = []
            for row_number, row in enumerate(reader, start=2):
                if None in row:
                    raise InputError(f"CSV row {row_number}: too many cells")
                rows.append(csv_numbers(row, row_number))
    else:
        raise InputError("--input must be a .json or .csv file")
    if not rows:
        raise InputError("The input batch must contain at least one row")
    features = []
    errors = []
    for row_number, row in enumerate(rows, start=1):
        try:
            features.append(ModelFeatures.model_validate(row))
        except ValueError as error:
            errors.append(f"row {row_number}: {error}")
    if errors:
        raise InputError("Invalid input batch:\n" + "\n".join(errors))
    return features


def load_predictor(path: Path):
    # Keeping this import after validation also keeps invalid-input checks usable
    # when optional model dependencies have not been installed.
    from app.congestion_model import CongestionModel
    return CongestionModel(path)


def serialize_results(results: list[Any], *, csv_output: bool) -> str:
    documents = [result.model_dump(mode="json") for result in results]
    if not csv_output:
        return json.dumps(documents, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=CSV_OUTPUT_FIELDS)
    writer.writeheader()
    for result in documents:
        writer.writerow({**result["features"], "prediction": result["prediction"]["value"],
                         "model_version": result["model_version"], "unit": result["prediction"]["unit"]})
    return stream.getvalue()


def atomic_write(path: Path, content: str) -> None:
    """Replace the destination only after the entire batch and file succeed."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as target:
            temporary = Path(target.name)
            target.write(content)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run(args: argparse.Namespace) -> None:
    output = args.output
    csv_output = output is not None and output.suffix.lower() == ".csv"
    if output is not None:
        if output.suffix.lower() not in {".json", ".csv"}:
            raise InputError("--output must end in .json or .csv")
        if output.resolve() == args.input.resolve():
            raise InputError("--output must differ from --input")
    if args.hourly and csv_output:
        raise InputError("--hourly requires JSON output so the full hourly profile is preserved")
    rows = load_input_rows(args.input)
    model_path = args.model or Path(os.environ.get("CATBOOST_MODEL_PATH") or DEFAULT_MODEL_PATH)
    predictor = load_predictor(model_path)
    results = [predictor.predict(row, include_hourly_profile=args.hourly) for row in rows]
    content = serialize_results(results, csv_output=csv_output)
    if output is None:
        sys.stdout.write(content)
    else:
        atomic_write(output, content)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="CSV or JSON with all seven raw features")
    parser.add_argument("--output", type=Path, help="JSON or CSV destination; default is a JSON array on stdout")
    parser.add_argument("--model", type=Path, help="CBM path; overrides CATBOOST_MODEL_PATH and the bundled model")
    parser.add_argument("--hourly", action="store_true", help="Include the 24-hour profile in JSON responses")
    args = parser.parse_args(argv)
    try:
        run(args)
    except Exception as error:
        print(f"Prediction failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
