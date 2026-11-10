"""Inference contract for the supplied CatBoost artifact, separate from annual forecasts."""
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, model_validator

from .forecast_models import Geography
from .models import ContractModel

DISTRICTS = {
    "Дзержинский": "district-dzerzhinsky",
    "Железнодорожный": "district-zheleznodorozhny",
    "Заельцовский": "district-zaeltsovsky",
    "Калининский": "district-kalininsky",
    "Кировский": "district-kirovsky",
    "Ленинский": "district-leninsky",
    "Октябрьский": "district-oktyabrsky",
    "Первомайский": "district-pervomaysky",
    "Советский": "district-sovetsky",
    "Центральный": "district-tsentralny",
}
WEEKDAYS = ("Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье")
DistrictName = Literal["Дзержинский", "Железнодорожный", "Заельцовский", "Калининский", "Кировский", "Ленинский", "Октябрьский", "Первомайский", "Советский", "Центральный"]
WeekdayName = Literal["Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота", "Воскресенье"]
RawFeatureName = Literal["hour", "district", "is_main_road", "day_of_week", "season", "lanes_total", "population"]
MAX_SAFE_INTEGER = 9007199254740991  # JSON/JavaScript interoperability, not a learned feature range.


class ModelFeatures(ContractModel):
    hour: Annotated[int, Field(strict=True, ge=0, le=23)]
    district: DistrictName
    is_main_road: Annotated[int, Field(strict=True, ge=0, le=1)]
    day_of_week: WeekdayName
    # The training categories are not recoverable from CBM hashes. Never guess/remap them.
    season: Annotated[str, StringConstraints(min_length=1, max_length=80, pattern=r"\S")]
    lanes_total: Annotated[int, Field(strict=True, ge=1, le=MAX_SAFE_INTEGER)]
    population: Annotated[int, Field(strict=True, ge=0, le=MAX_SAFE_INTEGER)]


class ModelPredictionRequest(ContractModel):
    features: ModelFeatures
    include_hourly_profile: bool = False


class ModelTarget(ContractModel):
    id: Literal["congestion_index_0_10"] = "congestion_index_0_10"
    name: str = "Расчётный индекс загруженности"
    unit: Literal["балл"] = "балл"
    expected_min: Literal[0] = 0
    expected_max: Literal[10] = 10
    description: str = "Оценка CatBoost по целевой переменной обучающего датасета; не время проезда и не измеренный процент загрузки."


class ModelFeatureDefinition(ContractModel):
    name: RawFeatureName
    label: str
    kind: Literal["integer", "category"]
    required: Literal[True] = True
    minimum: int | None = None
    maximum: int | None = None
    options: list[str] = Field(default_factory=list)


class ModelDistrict(ContractModel):
    name: DistrictName
    feature_id: str


class ModelMetadata(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    status: Literal["ready", "unavailable"]
    model_version: str
    model_sha256: str
    target: ModelTarget = Field(default_factory=ModelTarget)
    features: list[ModelFeatureDefinition]
    districts: list[ModelDistrict]
    season_suggestions: list[str]
    has_year_feature: Literal[False] = False
    disclaimer: str
    geography: Geography
    unavailable_reason: str | None


class ModelPredictionValue(ContractModel):
    value: float
    unit: Literal["балл"] = "балл"
    out_of_expected_range: bool


class HourlyPrediction(ContractModel):
    hour: Annotated[int, Field(ge=0, le=23)]
    value: float


class ModelPredictionResponse(ContractModel):
    schema_version: Literal["1.0"] = "1.0"
    model_version: str
    target: ModelTarget = Field(default_factory=ModelTarget)
    features: ModelFeatures
    feature_id: str
    prediction: ModelPredictionValue
    hourly_profile: list[HourlyPrediction] = Field(default_factory=list)
    warnings: list[str]

    @model_validator(mode="after")
    def coherent_result(self):
        if self.feature_id != DISTRICTS[self.features.district]:
            raise ValueError("feature_id must match the supplied district")
        if self.prediction.out_of_expected_range != (not 0 <= self.prediction.value <= 10):
            raise ValueError("out_of_expected_range must describe the raw prediction")
        if self.hourly_profile:
            if [point.hour for point in self.hourly_profile] != list(range(24)):
                raise ValueError("hourly_profile must contain hours 0–23 in order")
            if abs(self.hourly_profile[self.features.hour].value - self.prediction.value) > 1e-9:
                raise ValueError("selected hour and prediction must agree")
        return self
