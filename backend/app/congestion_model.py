"""Load a trained CBM once and perform inference only. No training code is used."""
import hashlib
import math
from pathlib import Path
from threading import Lock

from .forecast_models import Geography
from .model_schemas import (
    DISTRICTS, WEEKDAYS, MAX_SAFE_INTEGER, HourlyPrediction, ModelDistrict, ModelFeatureDefinition,
    ModelFeatures, ModelMetadata, ModelPredictionResponse, ModelPredictionValue,
)

DEFAULT_MODEL_PATH = Path(__file__).resolve().parents[1] / "models" / "catboost_congestion.cbm"
FEATURE_NAMES = ["hour", "district", "is_main_road", "day_of_week", "season", "lanes_total", "population", "hour_sin", "hour_cos", "dow_sin", "dow_cos"]
CATEGORICAL_INDICES = [1, 3, 4]
DISCLAIMER = "Модель оценивает расчётный индекс для заданного профиля дороги. Год не входит в признаки: результат не является прогнозом на 2027–2030 годы."
WARNINGS = [
    DISCLAIMER,
    "Целевая метрика построена расчётным способом; независимая проверка на измерениях дорожного движения не приложена.",
    "Граница района показывает контекст выбранного профиля дороги, а не среднюю загрузку района.",
    "Обучающий CSV и статистики заполнения пропусков отсутствуют: все семь признаков обязательны. Категорию сезона укажите точно как при обучении; её словарь не сохранён.",
    "Модель не предоставляет интервалы неопределённости или критические интервалы вмешательства.",
]


class ModelUnavailable(RuntimeError):
    pass


def prepare_row(features: ModelFeatures) -> list:
    """Same seven raw and four cyclic features as analyzer.ipynb, in CBM order."""
    weekday = WEEKDAYS.index(features.day_of_week)
    return [
        features.hour, features.district, features.is_main_road, features.day_of_week,
        features.season, features.lanes_total, features.population,
        math.sin(2 * math.pi * features.hour / 24), math.cos(2 * math.pi * features.hour / 24),
        math.sin(2 * math.pi * weekday / 7), math.cos(2 * math.pi * weekday / 7),
    ]


class CongestionModel:
    def __init__(self, path: Path = DEFAULT_MODEL_PATH):
        self.path = Path(path)
        self._model = None
        self._lock = Lock()
        self._sha256 = ""

    @property
    def model_sha256(self) -> str:
        return self._sha256

    @property
    def model_version(self) -> str:
        return f"catboost-{self._sha256[:16]}" if self._sha256 else "unavailable"

    def _load(self):
        with self._lock:
            if self._model is not None:
                return self._model
            if not self.path.is_file():
                raise ModelUnavailable("Файл модели не найден. Настройте CATBOOST_MODEL_PATH на сервере.")
            try:
                from catboost import CatBoostRegressor
            except (ImportError, OSError, ValueError) as exc:
                raise ModelUnavailable("CatBoost отсутствует или несовместим с окружением сервера. Установите backend/requirements-model.lock в Python 3.12.") from exc
            try:
                # Hash and load one immutable byte snapshot to keep version and predictions consistent.
                artifact = self.path.read_bytes()
                model = CatBoostRegressor()
                model.load_model(blob=artifact, format="cbm")
                if model.feature_names_ != FEATURE_NAMES or model.get_cat_feature_indices() != CATEGORICAL_INDICES:
                    raise ValueError("CBM feature contract differs from analyzer.ipynb")
                self._sha256 = hashlib.sha256(artifact).hexdigest()
                self._model = model
            except Exception as exc:
                raise ModelUnavailable("Не удалось загрузить CBM: проверьте совместимость модели с контрактом признаков.") from exc
            return self._model

    def status(self) -> tuple[str, str | None]:
        try:
            self._load()
        except ModelUnavailable as exc:
            return "unavailable", str(exc)
        return "ready", None

    def metadata(self, geography: Geography) -> ModelMetadata:
        status, reason = self.status()
        definitions = [
            ModelFeatureDefinition(name="hour", label="Час суток", kind="integer", minimum=0, maximum=23),
            ModelFeatureDefinition(name="district", label="Район", kind="category", options=list(DISTRICTS)),
            ModelFeatureDefinition(name="is_main_road", label="Главная дорога (1 — да, 0 — нет)", kind="integer", minimum=0, maximum=1),
            ModelFeatureDefinition(name="day_of_week", label="День недели", kind="category", options=list(WEEKDAYS)),
            ModelFeatureDefinition(name="season", label="Сезон (категория из обучения)", kind="category"),
            ModelFeatureDefinition(name="lanes_total", label="Всего полос на участке", kind="integer", minimum=1, maximum=MAX_SAFE_INTEGER),
            ModelFeatureDefinition(name="population", label="Население района, чел.", kind="integer", minimum=0, maximum=MAX_SAFE_INTEGER),
        ]
        return ModelMetadata(
            status=status, model_version=self.model_version, model_sha256=self.model_sha256,
            features=definitions, districts=[ModelDistrict(name=name, feature_id=feature_id) for name, feature_id in DISTRICTS.items()],
            season_suggestions=["Лето", "Не лето"], disclaimer=DISCLAIMER + " Написание категорий сезона необходимо сверить с обучающим CSV.",
            geography=geography, unavailable_reason=reason,
        )

    def predict(self, features: ModelFeatures, include_hourly_profile: bool = False) -> ModelPredictionResponse:
        features = ModelFeatures.model_validate(features.model_dump())
        model = self._load()
        from catboost import Pool
        inputs = [features.model_copy(update={"hour": hour}) for hour in range(24)] if include_hourly_profile else [features]
        try:
            pool = Pool([prepare_row(row) for row in inputs], feature_names=FEATURE_NAMES, cat_features=CATEGORICAL_INDICES)
            values = [float(value) for value in model.predict(pool, thread_count=1)]
        except Exception as exc:
            raise ModelUnavailable("Ошибка вычисления CatBoost. Проверьте файл модели и входные признаки.") from exc
        if not all(math.isfinite(value) for value in values):
            raise ModelUnavailable("Модель вернула нечисловой результат; предсказание недоступно.")
        value = values[features.hour] if include_hourly_profile else values[0]
        warnings = list(WARNINGS)
        if any(not 0 <= item <= 10 for item in values):
            warnings.append("Регрессия вернула значение за ожидаемым диапазоном 0–10. Исходный результат сохранён без обрезки.")
        return ModelPredictionResponse(
            model_version=self.model_version, features=features, feature_id=DISTRICTS[features.district],
            prediction=ModelPredictionValue(value=value, out_of_expected_range=not 0 <= value <= 10),
            hourly_profile=[HourlyPrediction(hour=hour, value=item) for hour, item in enumerate(values)] if include_hourly_profile else [],
            warnings=warnings,
        )
