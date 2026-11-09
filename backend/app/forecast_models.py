"""Public, provider-independent forecast contract. Missing numbers remain null."""
from math import fsum
from typing import Annotated, Any, Literal

from pydantic import Field, model_validator

from .models import ContractModel, LineGeometry, Position

Identifier = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]*$", max_length=80)]
Label = Annotated[str, Field(min_length=1)]
Aggregation = Literal["sum", "mean"]
QualityStatus = Literal["ok", "missing_baseline", "missing_forecast", "missing_both"]
Ring = Annotated[list[Position], Field(min_length=4)]
PolygonCoordinates = Annotated[list[Ring], Field(min_length=1)]


def check_rings(polygons: list[PolygonCoordinates]) -> None:
    for polygon in polygons:
        for ring in polygon:
            if ring[0] != ring[-1]:
                raise ValueError("GeoJSON polygon rings must be closed")


class PolygonGeometry(ContractModel):
    type: Literal["Polygon"]
    coordinates: PolygonCoordinates

    @model_validator(mode="after")
    def closed_rings(self):
        check_rings([self.coordinates])
        return self


class MultiPolygonGeometry(ContractModel):
    type: Literal["MultiPolygon"]
    coordinates: list[PolygonCoordinates] = Field(min_length=1)

    @model_validator(mode="after")
    def closed_rings(self):
        check_rings(self.coordinates)
        return self


class MultiLineGeometry(ContractModel):
    type: Literal["MultiLineString"]
    coordinates: list[Annotated[list[Position], Field(min_length=2)]] = Field(min_length=1)


class PointGeometry(ContractModel):
    type: Literal["Point"]
    coordinates: Position


GeometryType = Literal["Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point"]
Geometry = Annotated[PolygonGeometry | MultiPolygonGeometry | LineGeometry | MultiLineGeometry | PointGeometry, Field(discriminator="type")]


def positions(geometry):
    def walk(value):
        if len(value) == 2 and all(isinstance(v, (int, float)) for v in value):
            yield value
        else:
            for child in value:
                yield from walk(child)
    yield from walk(geometry.coordinates)


class BoundaryProperties(ContractModel):
    feature_id: Identifier
    name: Label
    source_id: Identifier | None = None


class BoundaryFeature(ContractModel):
    type: Literal["Feature"]
    id: Identifier
    geometry: Geometry
    properties: BoundaryProperties

    @model_validator(mode="after")
    def stable_id(self):
        if self.id != self.properties.feature_id:
            raise ValueError("GeoJSON id must equal properties.feature_id")
        return self


class BoundaryCollection(ContractModel):
    type: Literal["FeatureCollection"]
    features: list[BoundaryFeature] = Field(min_length=1)


class ReferencePoints(ContractModel):
    type: Literal["FeatureCollection"] = "FeatureCollection"
    features: list[BoundaryFeature] = Field(default_factory=list)

    @model_validator(mode="after")
    def only_points(self):
        if any(feature.geometry.type != "Point" for feature in self.features):
            raise ValueError("reference_points must contain only stop/station Points")
        return self


class GeographySource(ContractModel):
    id: Identifier
    name: Label
    url: Label
    attribution: Label
    license: Label
    license_url: str | None = None
    retrieved_at: Label


class GeographyLayer(ContractModel):
    id: Identifier
    name: Label
    geometry_types: list[GeometryType] = Field(min_length=1)
    source_id: Identifier
    asset_path: Label
    feature_count: int | None = Field(default=None, ge=0)
    description: str = ""

    @model_validator(mode="after")
    def safe_asset(self):
        from pathlib import PurePosixPath
        path = PurePosixPath(self.asset_path)
        if path.is_absolute() or ".." in path.parts or "\\" in self.asset_path or path.suffix != ".geojson":
            raise ValueError("Geography asset_path must be a relative GeoJSON asset without traversal")
        return self


class GeographyLayerFeature(ContractModel):
    type: Literal["Feature"]
    id: str | int | None = None
    geometry: Geometry
    properties: dict[str, Any]


class GeographyLayerCollection(ContractModel):
    type: Literal["FeatureCollection"]
    features: list[GeographyLayerFeature]


class Geography(ContractModel):
    crs: Literal["EPSG:4326"]
    description: Label
    # [west, south, east, north], decimal degrees; no projected coordinates.
    bbox: tuple[float, float, float, float]
    boundaries: BoundaryCollection
    reference_points: ReferencePoints = Field(default_factory=ReferencePoints)
    geography_version: Label = "unspecified"
    is_synthetic: bool = False
    sources: list[GeographySource] = Field(default_factory=list)
    layers: list[GeographyLayer] = Field(default_factory=list)

    @model_validator(mode="after")
    def valid_extent(self):
        west, south, east, north = self.bbox
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError("Invalid WGS84 bounding box")
        all_features = self.boundaries.features + self.reference_points.features
        ids = [feature.id for feature in all_features]
        if len(ids) != len(set(ids)):
            raise ValueError("Boundary feature IDs must be unique")
        for feature in all_features:
            if any(not (west <= x <= east and south <= y <= north) for x, y in positions(feature.geometry)):
                raise ValueError("Geographical coordinates must lie within geography.bbox")
        source_ids = [source.id for source in self.sources]
        if len(source_ids) != len(set(source_ids)):
            raise ValueError("Geography source IDs must be unique")
        if len({layer.id for layer in self.layers}) != len(self.layers):
            raise ValueError("Geography layer IDs must be unique")
        if any(layer.source_id not in source_ids for layer in self.layers):
            raise ValueError("Geography layers must reference a declared source")
        return self


class MetricDefinition(ContractModel):
    id: Identifier
    name: Label
    unit: Label
    description: Label
    aggregation: Aggregation
    semantic_type: Literal["population", "transport_load", "trip_demand", "passenger_flow", "transport_capacity", "traffic_intensity", "other"]
    geometry_types: list[GeometryType] = Field(min_length=1)

    @model_validator(mode="after")
    def valid_semantics(self):
        if len(self.geometry_types) != len(set(self.geometry_types)):
            raise ValueError("geometry_types must be unique")
        if self.semantic_type == "population" and not set(self.geometry_types) <= {"Polygon", "MultiPolygon"}:
            raise ValueError("Population zones must be polygons")
        if self.semantic_type == "transport_load":
            if self.aggregation != "mean" or self.unit != "%":
                raise ValueError("Transport load uses a mean in percent; never a sum of percentages")
            if not set(self.geometry_types) <= {"LineString", "MultiLineString"}:
                raise ValueError("Transport load must describe transport sections")
        return self


class ForecastScenario(ContractModel):
    id: Identifier
    name: Label
    description: Label


class ForecastMetadataResponse(ContractModel):
    schema_version: Literal["1.2"]
    base_year: int
    available_years: list[int] = Field(min_length=1)
    metrics: list[MetricDefinition] = Field(min_length=1)
    scenarios: list[ForecastScenario] = Field(min_length=1)
    geography: Geography
    data_version: Label
    is_demo: bool
    disclaimer: Label

    @model_validator(mode="after")
    def coherent_catalog(self):
        if self.available_years != sorted(set(self.available_years)):
            raise ValueError("available_years must be sorted and unique")
        if self.available_years[0] != self.base_year:
            raise ValueError("base_year must be the earliest available year from the data")
        for values in (self.metrics, self.scenarios):
            if len({value.id for value in values}) != len(values):
                raise ValueError("Catalog identifiers must be unique")
        for metric in self.metrics:
            if not any(feature.geometry.type in metric.geometry_types for feature in self.geography.boundaries.features):
                raise ValueError("Each metric must have declared geographical objects")
        return self


def changes(baseline: float | None, forecast: float | None) -> tuple[float | None, float | None]:
    if baseline is None or forecast is None:
        return None, None
    return round(forecast - baseline, 6), None if baseline == 0 else round((forecast - baseline) / baseline * 100, 6)


def quality_status(baseline: float | None, forecast: float | None) -> QualityStatus:
    if baseline is None:
        return "missing_both" if forecast is None else "missing_baseline"
    return "missing_forecast" if forecast is None else "ok"


class ForecastProperties(BoundaryProperties):
    baseline_value: float | None
    forecast_value: float | None
    delta_absolute: float | None
    delta_percent: float | None
    unit: Label
    quality_status: QualityStatus

    @model_validator(mode="after")
    def correct_changes(self):
        if (self.delta_absolute, self.delta_percent) != changes(self.baseline_value, self.forecast_value):
            raise ValueError("Deltas must match values; missing operands and zero denominators produce null")
        if self.quality_status != quality_status(self.baseline_value, self.forecast_value):
            raise ValueError("quality_status must describe the missing values")
        return self


class ForecastFeature(ContractModel):
    type: Literal["Feature"]
    id: Identifier
    geometry: Geometry
    properties: ForecastProperties

    @model_validator(mode="after")
    def stable_id(self):
        if self.id != self.properties.feature_id:
            raise ValueError("GeoJSON id must equal properties.feature_id")
        return self


class ForecastFeatureCollection(ContractModel):
    type: Literal["FeatureCollection"]
    features: list[ForecastFeature]


class ForecastAggregates(ContractModel):
    aggregation: Aggregation
    unit: Label
    feature_count: int = Field(ge=0)
    baseline_observed_count: int = Field(ge=0)
    forecast_observed_count: int = Field(ge=0)
    paired_observed_count: int = Field(ge=0)
    coverage_comparable: bool
    baseline_value: float | None
    forecast_value: float | None
    delta_absolute: float | None
    delta_percent: float | None


class YearComparison(ContractModel):
    role: Literal["baseline", "selected"]
    year: int
    value: float | None
    observed_feature_count: int = Field(ge=0)
    missing_feature_ids: list[Identifier]


class CriticalInterval(ContractModel):
    start_year: int
    end_year: int
    severity: Literal["low", "medium", "high", "critical"]
    affected_feature_ids: list[Identifier] = Field(min_length=1)
    metric: Identifier
    trigger_description: Label
    recommended_action: Label

    @model_validator(mode="after")
    def valid_interval(self):
        if self.start_year > self.end_year:
            raise ValueError("start_year must not exceed end_year")
        if len(self.affected_feature_ids) != len(set(self.affected_feature_ids)):
            raise ValueError("affected_feature_ids must be unique")
        return self


class DataQualityWarning(ContractModel):
    code: Identifier
    severity: Literal["info", "warning"]
    feature_ids: list[Identifier]
    message: Label


class ForecastResponse(ContractModel):
    schema_version: Literal["1.2"]
    base_year: int
    forecast_year: int
    metric: Identifier
    scenario: Identifier
    model_version: Label
    data_version: Label
    is_demo: bool
    disclaimer: Label
    geojson: ForecastFeatureCollection
    aggregates: ForecastAggregates
    comparison: list[YearComparison] = Field(min_length=2, max_length=2)
    critical_intervals: list[CriticalInterval]
    warnings: list[DataQualityWarning]

    @model_validator(mode="after")
    def coherent_response(self):
        if self.forecast_year < self.base_year:
            raise ValueError("forecast_year must not precede base_year")
        ids = [feature.id for feature in self.geojson.features]
        if len(ids) != len(set(ids)):
            raise ValueError("Forecast feature IDs must be unique")
        if any(feature.properties.unit != self.aggregates.unit for feature in self.geojson.features):
            raise ValueError("Feature and aggregate units must agree")
        aggregates, comparison = summarize(
            self.geojson, self.aggregates.unit, self.aggregates.aggregation, self.base_year, self.forecast_year,
        )
        if self.aggregates != aggregates or self.comparison != comparison:
            raise ValueError("Aggregates and comparison must match the map values and coverage")
        for interval in self.critical_intervals:
            if not set(interval.affected_feature_ids) <= set(ids):
                raise ValueError("Critical intervals reference unknown features")
            if interval.metric != self.metric:
                raise ValueError("Critical interval metric must match the selected metric")
            if interval.start_year > self.forecast_year or interval.end_year < self.base_year:
                raise ValueError("Critical interval must intersect the requested horizon")
        for warning in self.warnings:
            if not set(warning.feature_ids) <= set(ids):
                raise ValueError("Data quality warnings reference unknown features")
        missing_ids = {feature.id for feature in self.geojson.features if feature.properties.quality_status != "ok"}
        warned_ids = {id_ for warning in self.warnings for id_ in warning.feature_ids}
        if not missing_ids <= warned_ids:
            raise ValueError("Missing feature values must be covered by data quality warnings")
        return self


def aggregate(values: list[float | None], method: Aggregation) -> float | None:
    observed = [value for value in values if value is not None]
    if not observed:
        return None
    return round(fsum(observed) / (len(observed) if method == "mean" else 1), 6)


def summarize(
    geojson: ForecastFeatureCollection, unit: str, method: Aggregation, base_year: int, forecast_year: int,
) -> tuple[ForecastAggregates, list[YearComparison]]:
    features = geojson.features
    baseline_ids = {feature.id for feature in features if feature.properties.baseline_value is not None}
    forecast_ids = {feature.id for feature in features if feature.properties.forecast_value is not None}
    baseline = aggregate([feature.properties.baseline_value for feature in features], method)
    forecast = aggregate([feature.properties.forecast_value for feature in features], method)
    comparable = bool(baseline_ids) and baseline_ids == forecast_ids
    delta_absolute, delta_percent = changes(baseline, forecast) if comparable else (None, None)
    return ForecastAggregates(
        aggregation=method, unit=unit, feature_count=len(features),
        baseline_observed_count=len(baseline_ids), forecast_observed_count=len(forecast_ids),
        paired_observed_count=len(baseline_ids & forecast_ids), coverage_comparable=comparable,
        baseline_value=baseline, forecast_value=forecast, delta_absolute=delta_absolute, delta_percent=delta_percent,
    ), [
        YearComparison(role="baseline", year=base_year, value=baseline, observed_feature_count=len(baseline_ids), missing_feature_ids=sorted(set(f.id for f in features) - baseline_ids)),
        YearComparison(role="selected", year=forecast_year, value=forecast, observed_feature_count=len(forecast_ids), missing_feature_ids=sorted(set(f.id for f in features) - forecast_ids)),
    ]


class ForecastQuery(ContractModel):
    year: int
    metric: Identifier
    scenario: Identifier
