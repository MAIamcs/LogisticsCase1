import type { ForecastMetadata, ForecastSelection } from '../data/forecast-client';
import { geographyFeatures } from './map-model';
import { initialSelection } from './presentation';

const keys = { year: 'year', metric: 'metric', scenario: 'scenario', feature: 'feature' };

export function linkedFeature(search: string): string {
  const value = new URLSearchParams(search).get(keys.feature) ?? '';
  return value.length <= 120 ? value : '';
}

export function linkedSelection(metadata: ForecastMetadata, search: string, current?: ForecastSelection | null): ForecastSelection {
  const fallback = initialSelection(metadata);
  const parameters = new URLSearchParams(search);
  const rawYear = parameters.get(keys.year) ?? '';
  const year = /^\d+$/.test(rawYear) && Number.isSafeInteger(Number(rawYear)) ? Number(rawYear) : fallback.year;
  const candidate = current ?? { year, metric: parameters.get(keys.metric) ?? fallback.metric, scenario: parameters.get(keys.scenario) ?? fallback.scenario };
  return {
    year: metadata.available_years.includes(candidate.year) ? candidate.year : fallback.year,
    metric: metadata.metrics.some(metric => metric.id === candidate.metric) ? candidate.metric : fallback.metric,
    scenario: metadata.scenarios.some(scenario => scenario.id === candidate.scenario) ? candidate.scenario : fallback.scenario,
  };
}

/** Query parameters keep links shareable and refreshable on plain GitHub Pages.
 * No nested client route, local storage, credentials or geometry is persisted. */
export function workspaceLink(href: string, metadata: ForecastMetadata, selection: ForecastSelection, feature: string): string {
  const url = new URL(href);
  const valid = linkedSelection(metadata, '', selection);
  url.searchParams.set(keys.year, String(valid.year));
  url.searchParams.set(keys.metric, valid.metric);
  url.searchParams.set(keys.scenario, valid.scenario);
  if (feature && geographyFeatures(metadata).some(object => object.id === feature)) url.searchParams.set(keys.feature, feature);
  else url.searchParams.delete(keys.feature);
  return `${url.pathname}${url.search}${url.hash}`;
}
