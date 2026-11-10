"""Batch validation and output safety for the standalone inference command."""
import csv
import importlib.util
import io
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("predict_congestion_cli", ROOT / "scripts" / "predict_congestion.py")
cli = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cli)


@pytest.fixture
def row():
    return {"hour": 8, "district": "Центральный", "is_main_road": 1,
            "day_of_week": "Понедельник", "season": "Лето", "lanes_total": 4, "population": 100000}


class Response:
    def __init__(self, features, hourly):
        self.document = {
            "schema_version": "1.0", "model_version": "test-model", "target": "congestion_index_0_10",
            "features": features.model_dump(mode="json"), "feature_id": "district-tsentralny",
            "prediction": {"value": 3.25, "unit": "балл", "out_of_expected_range": False},
            "hourly_profile": [{"hour": hour, "value": 3.25} for hour in range(24)] if hourly else [],
            "warnings": [],
        }

    def model_dump(self, *, mode):
        return self.document


def test_json_single_row_preserves_full_response_and_explicit_model(tmp_path, monkeypatch, capsys, row):
    source = tmp_path / "inputs.json"
    source.write_text(json.dumps(row, ensure_ascii=False), encoding="utf-8")
    selected = []

    class Predictor:
        def predict(self, features, include_hourly_profile=False):
            return Response(features, include_hourly_profile)

    def load(path):
        selected.append(path)
        return Predictor()

    monkeypatch.setattr(cli, "load_predictor", load)
    monkeypatch.setenv("CATBOOST_MODEL_PATH", "environment.cbm")
    assert cli.main(["--input", str(source), "--model", "explicit.cbm", "--hourly"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert selected == [Path("explicit.cbm")]
    assert len(result) == 1
    assert result[0]["features"] == row
    assert result[0]["prediction"]["unit"] == "балл"
    assert [point["hour"] for point in result[0]["hourly_profile"]] == list(range(24))


@pytest.mark.parametrize("format", ["json", "csv"])
def test_invalid_later_row_prevents_model_loading_and_preserves_output(tmp_path, monkeypatch, capsys, row, format):
    source, output = tmp_path / f"inputs.{format}", tmp_path / "predictions.json"
    if format == "json":
        bad = {key: value for key, value in row.items() if key != "population"}
        source.write_text(json.dumps([row, bad], ensure_ascii=False), encoding="utf-8")
    else:
        with source.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=cli.RAW_FIELDS)
            writer.writeheader()
            writer.writerows([row, {**row, "population": ""}])
    output.write_text("previous successful batch\n", encoding="utf-8")

    def forbidden_load(path):
        pytest.fail("The model must not load before the entire input batch validates")

    monkeypatch.setattr(cli, "load_predictor", forbidden_load)
    assert cli.main(["--input", str(source), "--output", str(output)]) == 2
    assert "population" in capsys.readouterr().err
    assert output.read_text() == "previous successful batch\n"


def test_inference_failure_does_not_write_partial_batch(tmp_path, monkeypatch, row):
    source, output = tmp_path / "inputs.json", tmp_path / "predictions.json"
    source.write_text(json.dumps([row, {**row, "hour": 9}]), encoding="utf-8")
    output.write_text("previous successful batch\n", encoding="utf-8")

    class Predictor:
        def predict(self, features, include_hourly_profile=False):
            if features.hour == 9:
                raise RuntimeError("Model inference unavailable")
            return Response(features, include_hourly_profile)

    monkeypatch.setattr(cli, "load_predictor", lambda path: Predictor())
    assert cli.main(["--input", str(source), "--output", str(output)]) == 2
    assert output.read_text() == "previous successful batch\n"
    assert not list(tmp_path.glob("*.tmp"))


def test_csv_round_trip_uses_required_flat_columns(tmp_path, monkeypatch, row):
    source, output = tmp_path / "inputs.csv", tmp_path / "predictions.csv"
    with source.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=cli.RAW_FIELDS)
        writer.writeheader()
        writer.writerow(row)

    class Predictor:
        def predict(self, features, include_hourly_profile=False):
            assert features.model_dump(mode="json") == row
            return Response(features, include_hourly_profile)

    monkeypatch.setattr(cli, "load_predictor", lambda path: Predictor())
    assert cli.main(["--input", str(source), "--output", str(output)]) == 0
    reader = csv.DictReader(io.StringIO(output.read_text(encoding="utf-8")))
    assert reader.fieldnames == list(cli.CSV_OUTPUT_FIELDS)
    result = list(reader)
    assert len(result) == 1
    assert result[0]["district"] == row["district"]
    assert result[0]["prediction"] == "3.25"
    assert result[0]["model_version"] == "test-model"
    assert result[0]["unit"] == "балл"


@pytest.mark.parametrize("population", [9007199254740991, 9007199254740993])
def test_csv_integer_parsing_preserves_value_before_shared_range_validation(tmp_path, row, population):
    source = tmp_path / "inputs.csv"
    # The larger value changes if parsed through float. Preserve it exactly so
    # the shared schema can reject the actual input at its interoperability bound.
    raw = {key: str(value) for key, value in {**row, "population": population}.items()}
    assert cli.csv_numbers(raw, 2)["population"] == population
    with source.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=cli.RAW_FIELDS)
        writer.writeheader()
        writer.writerow({**row, "population": population})
    if population == 9007199254740991:
        assert cli.load_input_rows(source)[0].population == population
    else:
        with pytest.raises(cli.InputError, match="less_than_equal"):
            cli.load_input_rows(source)


def test_failed_atomic_replace_preserves_existing_file_and_removes_temporary(tmp_path, monkeypatch):
    output = tmp_path / "predictions.json"
    output.write_text("previous successful batch", encoding="utf-8")

    def fail_replace(source, destination):
        raise OSError("replace failed")

    monkeypatch.setattr(cli.os, "replace", fail_replace)
    with pytest.raises(OSError, match="replace failed"):
        cli.atomic_write(output, "new batch")
    assert output.read_text() == "previous successful batch"
    assert set(tmp_path.iterdir()) == {output}
