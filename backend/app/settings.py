import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .forecast_provider import DEFAULT_DEMO_DIRECTORY
from .geography_provider import DEFAULT_GEOGRAPHY_DIRECTORY


@dataclass(frozen=True)
class Settings:
    cors_allow_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")
    cors_allow_credentials: bool = False
    forecast_demo_data_dir: Path = DEFAULT_DEMO_DIRECTORY
    geography_data_dir: Path = DEFAULT_GEOGRAPHY_DIRECTORY

    def __post_init__(self):
        for origin in self.cors_allow_origins:
            if origin == "*":
                raise ValueError("CORS_ALLOW_ORIGINS must list explicit origins; '*' is not supported, including with credentials")
            url = urlsplit(origin)
            try:
                valid = url.scheme in {"http", "https"} and bool(url.hostname) and not (
                    url.path or url.query or url.fragment or url.username or url.password
                )
                _ = url.port
            except ValueError:
                valid = False
            if not valid:
                raise ValueError(f"Invalid CORS origin '{origin}': use scheme://host[:port] without a path or trailing slash")

    @classmethod
    def from_environment(cls):
        credentials = os.getenv("CORS_ALLOW_CREDENTIALS", "false").lower()
        if credentials not in {"true", "false"}:
            raise ValueError("CORS_ALLOW_CREDENTIALS must be true or false")
        return cls(
            cors_allow_origins=tuple(origin.strip() for origin in os.getenv(
                "CORS_ALLOW_ORIGINS", ",".join(cls().cors_allow_origins)
            ).split(",") if origin.strip()),
            cors_allow_credentials=credentials == "true",
            forecast_demo_data_dir=Path(os.getenv("FORECAST_DEMO_DATA_DIR", str(DEFAULT_DEMO_DIRECTORY))),
            geography_data_dir=Path(os.getenv("GEOGRAPHY_DATA_DIR", str(DEFAULT_GEOGRAPHY_DIRECTORY))),
        )
