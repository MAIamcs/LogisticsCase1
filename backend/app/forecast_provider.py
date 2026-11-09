"""Replace this provider through dependency injection; HTTP routes stay unchanged."""
from pathlib import Path
from typing import Protocol

from fastapi import Request

from .forecast_models import ForecastMetadataResponse, ForecastResponse

DEFAULT_DEMO_DIRECTORY = Path(__file__).resolve().parents[2] / "contracts" / "fixtures" / "forecast"


class InvalidForecastSelection(ValueError):
    def __init__(self, field: str, selected: str | int, allowed: list):
        self.field = field
        super().__init__(f"Unknown {field} '{selected}'. Available values: {', '.join(map(str, allowed))}.")


class ForecastProviderUnavailable(RuntimeError):
    """Provider cannot currently supply data; clients may retry later."""


class ForecastProvider(Protocol):
    @property
    def is_demo(self) -> bool: ...

    def get_metadata(self) -> ForecastMetadataResponse: ...

    def get_forecast(self, *, year: int, metric: str, scenario: str) -> ForecastResponse: ...


def validate_selection(metadata: ForecastMetadataResponse, *, year: int, metric: str, scenario: str) -> None:
    for field, selected, allowed in [
        ("year", year, metadata.available_years),
        ("metric", metric, [item.id for item in metadata.metrics]),
        ("scenario", scenario, [item.id for item in metadata.scenarios]),
    ]:
        if selected not in allowed:
            raise InvalidForecastSelection(field, selected, allowed)


def validate_provider_response(
    metadata: ForecastMetadataResponse, response: ForecastResponse, *, year: int, metric: str, scenario: str,
) -> None:
    if (response.base_year, response.forecast_year, response.metric, response.scenario, response.data_version, response.is_demo) != (
        metadata.base_year, year, metric, scenario, metadata.data_version, metadata.is_demo,
    ):
        raise ValueError("Provider response identity/provenance does not match metadata and request")
    definition = next(item for item in metadata.metrics if item.id == metric)
    if (response.aggregates.unit, response.aggregates.aggregation) != (definition.unit, definition.aggregation):
        raise ValueError("Provider response units/aggregation do not match metric metadata")
    boundaries = {feature.id: feature for feature in metadata.geography.boundaries.features if feature.geometry.type in definition.geometry_types}
    if {feature.id for feature in response.geojson.features} != set(boundaries):
        raise ValueError("Provider response must cover all objects declared for this metric's geometry types; missing values stay null")
    for feature in response.geojson.features:
        boundary = boundaries[feature.id]
        if feature.geometry != boundary.geometry or feature.properties.name != boundary.properties.name or feature.properties.source_id != boundary.properties.source_id:
            raise ValueError("Provider response geometry/name/source does not match declared boundaries")


class DemoForecastProvider:
    """Concrete ForecastProvider serving the exact published static demo files."""

    def __init__(self, directory: Path = DEFAULT_DEMO_DIRECTORY):
        self.directory = directory

    @property
    def is_demo(self) -> bool:
        return True

    def get_metadata(self) -> ForecastMetadataResponse:
        try:
            metadata = ForecastMetadataResponse.model_validate_json((self.directory / "metadata.json").read_text(encoding="utf-8"))
        except OSError as exc:
            raise ForecastProviderUnavailable("Forecast demo data is unavailable.") from exc
        if not metadata.is_demo:
            raise ValueError("DemoForecastProvider requires is_demo=true")
        return metadata

    def get_forecast(self, *, year: int, metric: str, scenario: str) -> ForecastResponse:
        metadata = self.get_metadata()
        # Validate the catalog whitelist BEFORE constructing any file path.
        validate_selection(metadata, year=year, metric=metric, scenario=scenario)
        try:
            response = ForecastResponse.model_validate_json(
                (self.directory / scenario / metric / f"{year}.json").read_text(encoding="utf-8")
            )
        except OSError as exc:
            raise ForecastProviderUnavailable("Selected forecast demo data is unavailable.") from exc
        validate_provider_response(metadata, response, year=year, metric=metric, scenario=scenario)
        return response


def get_forecast_provider(request: Request) -> ForecastProvider:
    return request.app.state.forecast_provider
