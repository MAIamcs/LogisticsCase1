import logging
from typing import Annotated

from fastapi import Depends, FastAPI, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException

from .forecast_models import ForecastMetadataResponse, ForecastQuery, ForecastResponse, Geography, GeographyLayerCollection
from .forecast_provider import (
    DemoForecastProvider, ForecastProvider, ForecastProviderUnavailable, InvalidForecastSelection,
    get_forecast_provider, validate_provider_response, validate_selection,
)
from .models import ErrorResponse, HealthResponse, PlanningResponse, ScenarioListResponse
from .geography_provider import GeographyProvider, LocalGeographyProvider
from .services import PlanningService, get_planning_service
from .settings import Settings

Service = Annotated[PlanningService, Depends(get_planning_service)]
Provider = Annotated[ForecastProvider, Depends(get_forecast_provider)]
errors = {
    404: {"model": ErrorResponse}, 422: {"model": ErrorResponse},
    500: {"model": ErrorResponse}, 503: {"model": ErrorResponse},
}


def error_response(status: int, code: str, message: str, details: list[dict] | None = None) -> JSONResponse:
    error = {"code": code, "message": message}
    if details is not None:
        error["details"] = details
    return JSONResponse(status_code=status, content={"error": error})


def validated_metadata(provider: ForecastProvider) -> ForecastMetadataResponse:
    value = provider.get_metadata()
    metadata = ForecastMetadataResponse.model_validate(value.model_dump())
    if metadata.is_demo != provider.is_demo:
        raise ValueError("Provider metadata has contradictory demo provenance")
    return metadata


def create_app(*, settings: Settings | None = None, forecast_provider: ForecastProvider | None = None, geography_provider: GeographyProvider | None = None) -> FastAPI:
    settings = settings or Settings.from_environment()
    app = FastAPI(
        title="Novosibirsk Transport Planning API", version="0.4.0",
        description="Provider-independent forecast and real geography API. Statistical values from the default provider remain synthetic demonstrations, not a real forecast.",
    )
    app.state.forecast_provider = forecast_provider if forecast_provider is not None else DemoForecastProvider(settings.forecast_demo_data_dir)
    app.state.geography_provider = geography_provider if geography_provider is not None else LocalGeographyProvider(settings.geography_data_dir)
    app.add_middleware(
        CORSMiddleware, allow_origins=list(settings.cors_allow_origins),
        allow_credentials=settings.cors_allow_credentials,
        allow_methods=["GET"], allow_headers=["Accept", "Content-Type"],
    )

    @app.exception_handler(HTTPException)
    async def http_error(_request: Request, exc: HTTPException):
        return error_response(exc.status_code, "not_found" if exc.status_code == 404 else "validation_error", str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError):
        details = [{"field": ".".join(map(str, issue["loc"])), "message": issue["msg"]} for issue in exc.errors()]
        message = "Invalid request parameters: " + "; ".join(f'{item["field"]}: {item["message"]}' for item in details)
        return error_response(422, "validation_error", message, details)

    @app.exception_handler(InvalidForecastSelection)
    async def invalid_selection(_request: Request, exc: InvalidForecastSelection):
        return error_response(422, "validation_error", str(exc), [{"field": exc.field, "message": str(exc)}])

    @app.exception_handler(ForecastProviderUnavailable)
    async def provider_unavailable(_request: Request, exc: ForecastProviderUnavailable):
        logging.getLogger(__name__).warning("Forecast provider unavailable", exc_info=exc)
        return error_response(503, "service_unavailable", "Forecast provider is unavailable. Please retry later.")

    @app.exception_handler(ValueError)
    @app.exception_handler(Exception)
    async def unexpected_error(_request: Request, exc: Exception):
        logging.getLogger(__name__).error("Planning service failed", exc_info=exc)
        return error_response(500, "internal_error", "Planning service failed")

    @app.get("/api/v1/health", response_model=HealthResponse)
    def health(provider: Provider):
        return HealthResponse(model_status="not_integrated" if provider.is_demo else "provider_configured")

    @app.get("/api/v1/metadata", response_model=ForecastMetadataResponse, responses=errors)
    def metadata(provider: Provider):
        return validated_metadata(provider)

    @app.get("/api/v1/geography", response_model=Geography, responses=errors)
    def geography(provider: Provider):
        """Real boundaries, layer descriptors, provenance and geography version."""
        return validated_metadata(provider).geography

    @app.get("/api/v1/geography/layers/{layer_id}", response_model=GeographyLayerCollection, responses=errors)
    def geographic_layer(layer_id: Annotated[str, Path(pattern=r"^[a-z][a-z0-9_-]*$", max_length=80)], provider: Provider, request: Request):
        catalog = validated_metadata(provider).geography
        layer = next((item for item in catalog.layers if item.id == layer_id), None)
        if layer is None:
            raise HTTPException(status_code=404, detail="Unknown geographic layer. Available layers: " + ", ".join(item.id for item in catalog.layers))
        return request.app.state.geography_provider.get_layer(layer)

    @app.get("/api/v1/forecast", response_model=ForecastResponse, responses=errors)
    def forecast(selection: Annotated[ForecastQuery, Query()], provider: Provider):
        catalog = validated_metadata(provider)
        query = selection.model_dump()
        validate_selection(catalog, **query)
        value = provider.get_forecast(**query)
        # Revalidate even already-constructed/mutated provider objects at the boundary.
        result = ForecastResponse.model_validate(value.model_dump())
        validate_provider_response(catalog, result, **query)
        return result

    # Preserve the current corridor workspace until the forecast UI is integrated.
    @app.get("/api/v1/scenarios", response_model=ScenarioListResponse, responses=errors)
    def scenarios(service: Service):
        return service.list_scenarios()

    @app.get("/api/v1/scenarios/{scenario_id}", response_model=PlanningResponse, responses=errors)
    def scenario(scenario_id: Annotated[str, Path(pattern=r"^[a-z0-9-]+$", max_length=80)], service: Service):
        try:
            return service.get_scenario(scenario_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Scenario not found") from None

    return app


app = create_app()
