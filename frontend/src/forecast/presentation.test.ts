import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ForecastMetadata } from '../data/forecast-client';
import { barGeometry, chartDomain, deltaUnitLabel, formatDelta, formatValue, initialSelection, summaryForSelection, yearPosition } from './presentation';

describe('forecast presentation semantics', () => {
  it('keeps observed zero different from missing values', () => {
    expect(formatValue(0)).toBe('0');
    expect(formatValue(null)).toBe('Нет данных');
    expect(formatValue(undefined)).toBe('Нет данных');
    expect(formatDelta(0)).toBe('0');
    expect(formatDelta(null)).toBe('Не определено');
    expect(deltaUnitLabel('%')).toBe('п.п.');
    expect(deltaUnitLabel('persons')).toBe('чел.');
  });
  it('chooses years and indicators exclusively from provider metadata', () => {
    const metadata: ForecastMetadata = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/forecast/metadata.json', import.meta.url), 'utf8'));
    metadata.base_year = 2018;
    metadata.available_years = [2018, 2022, 2039, 2057];
    metadata.metrics[0].id = 'provider_metric';
    metadata.scenarios[0].id = 'provider_scenario';
    expect(initialSelection(metadata)).toEqual({ year: 2018, metric: 'provider_metric', scenario: 'provider_scenario' });
    metadata.available_years = [2018];
    expect(initialSelection(metadata).year).toBe(2018);
  });
  it('positions supplied calendar intervals correctly between uneven year ticks', () => {
    const years = [2024, 2030, 2035, 2040];
    expect(yearPosition(2024, years)).toBe(0);
    expect(yearPosition(2030, years)).toBeCloseTo(1 / 3);
    expect(yearPosition(2028, years)).toBeCloseTo(2 / 9);
    expect(yearPosition(2032, years)).toBeCloseTo(7 / 15);
    expect(yearPosition(2042, years)).toBe(1);
    expect(yearPosition(2020, years)).toBe(0);
    expect(yearPosition(2024, [2024])).toBe(0);
  });
  it('shows the selected object in KPIs without substituting city totals for missing observations', () => {
    const forecast = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/forecast/baseline/population/2030.json', import.meta.url), 'utf8'));
    const feature = forecast.geojson.features[0];
    expect(summaryForSelection(forecast, '')).toBe(forecast.aggregates);
    expect(summaryForSelection(forecast, feature.id)?.forecast_value).toBe(feature.properties.forecast_value);
    expect(summaryForSelection(forecast, feature.id)?.feature_count).toBe(1);
    expect(summaryForSelection(forecast, 'reference-station')).toMatchObject({ baseline_value: null, forecast_value: null, delta_absolute: null, delta_percent: null, baseline_observed_count: 0, forecast_observed_count: 0, coverage_comparable: false });
    expect(summaryForSelection(null, '')).toBeUndefined();
  });
  it('preserves the zero origin and negative values in comparative charts', () => {
    expect(chartDomain([null, 0, 10])).toEqual([0, 10]);
    expect(chartDomain([null, null])).toEqual([0, 1]);
    expect(barGeometry(0, [0, 10])).toEqual({ left: '0%', width: '0%' });
    expect(barGeometry(-10, [-20, 20])).toEqual({ left: '25%', width: '25%' });
    expect(barGeometry(10, [-20, 20])).toEqual({ left: '50%', width: '25%' });
  });
});
