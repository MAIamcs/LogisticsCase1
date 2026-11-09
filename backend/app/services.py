"""Read-only seam for integrating the analytical model later."""
from pathlib import Path
from typing import Protocol

from .models import PlanningResponse, ScenarioListResponse

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"


class PlanningService(Protocol):
    def list_scenarios(self) -> ScenarioListResponse: ...
    def get_scenario(self, scenario_id: str) -> PlanningResponse: ...


class FixturePlanningService:
    def __init__(self, directory: Path = FIXTURE_DIR):
        self.directory = directory

    def list_scenarios(self) -> ScenarioListResponse:
        return ScenarioListResponse.model_validate_json(
            (self.directory / "scenarios.json").read_text(encoding="utf-8")
        )

    def get_scenario(self, scenario_id: str) -> PlanningResponse:
        # Whitelist from the catalog before constructing a path.
        if scenario_id not in {s.id for s in self.list_scenarios().data}:
            raise KeyError(scenario_id)
        return PlanningResponse.model_validate_json(
            (self.directory / f"{scenario_id}.json").read_text(encoding="utf-8")
        )


def get_planning_service() -> PlanningService:
    return FixturePlanningService()
