"""Geographic layer transport is independent from the future statistical model."""
from pathlib import Path
from typing import Protocol

from .forecast_models import GeographyLayer, GeographyLayerCollection
from .forecast_provider import ForecastProviderUnavailable

DEFAULT_GEOGRAPHY_DIRECTORY = Path(__file__).resolve().parents[2] / "contracts" / "geography"


class GeographyProvider(Protocol):
    def get_layer(self, layer: GeographyLayer) -> GeographyLayerCollection: ...


class LocalGeographyProvider:
    """Serve the same versioned real GeoJSON assets copied by the static build."""

    def __init__(self, directory: Path = DEFAULT_GEOGRAPHY_DIRECTORY):
        self.directory = directory

    def get_layer(self, layer: GeographyLayer) -> GeographyLayerCollection:
        # The public path is relative to the frontend root (geography/foo.geojson).
        # Restrict actual file access to the configured geographic asset directory.
        path = self.directory / Path(layer.asset_path).name
        try:
            result = GeographyLayerCollection.model_validate_json(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise ForecastProviderUnavailable("Geographic data is unavailable.") from exc
        if any(feature.geometry.type not in layer.geometry_types for feature in result.features):
            raise ValueError("Geographic layer geometries do not match the declared layer types")
        return result
