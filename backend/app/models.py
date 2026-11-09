"""Authoritative API models. Export schemas before changing consumers."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Metadata(ContractModel):
    schema_version: Literal["1.0"]
    source: Literal["synthetic", "model"]
    is_synthetic: bool
    disclaimer: str = Field(min_length=1)

    @model_validator(mode="after")
    def consistent_source(self):
        if self.is_synthetic != (self.source == "synthetic"):
            raise ValueError("source and is_synthetic must agree")
        return self


class Scenario(ContractModel):
    id: str = Field(pattern=r"^[a-z0-9-]+$", max_length=80)
    name: str
    description: str
    period: str


class ScenarioListResponse(ContractModel):
    meta: Metadata
    data: list[Scenario]


Longitude = Annotated[float, Field(ge=-180, le=180)]
Latitude = Annotated[float, Field(ge=-90, le=90)]
Position = tuple[Longitude, Latitude]


class LineGeometry(ContractModel):
    type: Literal["LineString"]
    coordinates: list[Position] = Field(min_length=2)


class CorridorProperties(ContractModel):
    id: str
    name: str
    from_name: str
    to_name: str
    load_percent: float = Field(ge=0, le=100)
    travel_time_min: float = Field(gt=0)
    length_km: float = Field(gt=0)
    daily_trips: int = Field(ge=0)


class CorridorFeature(ContractModel):
    type: Literal["Feature"]
    id: str
    geometry: LineGeometry
    properties: CorridorProperties

    @model_validator(mode="after")
    def consistent_id(self):
        if self.id != self.properties.id:
            raise ValueError("feature and properties IDs must agree")
        return self


class CorridorCollection(ContractModel):
    type: Literal["FeatureCollection"]
    features: list[CorridorFeature]

    @model_validator(mode="after")
    def unique_ids(self):
        ids = [feature.id for feature in self.features]
        if len(ids) != len(set(ids)):
            raise ValueError("corridor IDs must be unique")
        return self


class Summary(ContractModel):
    daily_trips: int = Field(ge=0)
    mean_travel_time_min: float = Field(ge=0)
    mean_load_percent: float = Field(ge=0, le=100)


class PlanningData(ContractModel):
    scenario: Scenario
    summary: Summary
    corridors: CorridorCollection


class PlanningResponse(ContractModel):
    meta: Metadata
    data: PlanningData


class HealthResponse(ContractModel):
    status: Literal["ok"] = "ok"
    service: Literal["transport-planning-api"] = "transport-planning-api"
    model_status: Literal["not_integrated", "provider_configured"] = "not_integrated"


class ValidationIssue(ContractModel):
    field: str
    message: str


class ErrorDetail(ContractModel):
    code: Literal["not_found", "validation_error", "service_unavailable", "internal_error"]
    message: str
    details: list[ValidationIssue] | None = None


class ErrorResponse(ContractModel):
    error: ErrorDetail
