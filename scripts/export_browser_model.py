"""Export the existing CBM's inference data for the browser. Never trains or reads training rows."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from catboost import CatBoostRegressor, Pool
from app.congestion_model import DEFAULT_MODEL_PATH, FEATURE_NAMES, prepare_row
from app.model_schemas import DISTRICTS, WEEKDAYS, ModelFeatures


def serialize(value):
    if isinstance(value, dict):
        return {str(k): serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serialize(v) for v in value]
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return {key: serialize(item) for key, item in vars(value).items() if not key.startswith('_')}


def export():
    model = CatBoostRegressor()
    model.load_model(str(DEFAULT_MODEL_PATH))
    # Export needs the string -> hash dictionary. These are vocabulary probes,
    # not observations or training data; their numeric values never enter output.
    probes = [prepare_row(ModelFeatures(hour=0, district=district, is_main_road=1,
               day_of_week=day, season=season, lanes_total=1, population=0))
              for district in DISTRICTS for day in WEEKDAYS for season in ('Лето', 'Не лето')]
    pool = Pool(probes, feature_names=FEATURE_NAMES, cat_features=[1, 3, 4])
    with tempfile.TemporaryDirectory() as temporary:
        folder = Path(temporary)
        model.save_model(str(folder / 'model.py'), format='python', pool=pool)
        model.save_model(str(folder / 'model.json'), format='json')
        spec = importlib.util.spec_from_file_location('generated_catboost_inference', folder / 'model.py')
        generated = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generated)
        exact = json.loads((folder / 'model.json').read_text())
        data = serialize(generated.catboost_model)
        # The Python exporter prints borders with fewer significant figures.
        # Use the exact CBM JSON values at decision boundaries.
        float_features = exact['features_info']['float_features']
        data['float_feature_borders'] = [feature['borders'] for feature in float_features if feature['borders']]
        data['ctr_feature_borders'] = [ctr['borders'] for ctr in exact['features_info']['ctrs']]
        data['leaf_values'] = [value for tree in exact['oblivious_trees'] for value in tree['leaf_values']]
        hashes = {key.encode('latin-1').decode('utf-8'): value for key, value in generated.cat_features_hashes.items()}
    payload = {
        'schema_version': '1.0', 'model_sha256': hashlib.sha256(DEFAULT_MODEL_PATH.read_bytes()).hexdigest(),
        'feature_names': FEATURE_NAMES, 'categorical_hashes': hashes, 'data': data,
        'provenance': 'Inference data exported from supplied CBM; no fitting, training rows, labels or imputation.'}
    target = ROOT / 'contracts/fixtures/model/browser-model.json'
    target.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
    print(f'Exported {data["tree_count"]} trees, {target.stat().st_size} bytes')


if __name__ == '__main__':
    export()
