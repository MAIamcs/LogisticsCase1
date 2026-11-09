import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ForecastMetadata, ForecastResponse } from '../data/forecast-client';
import { changeScale } from '../forecast/map-model';
import { ForecastComparison } from './ForecastComparison';

const metadata: ForecastMetadata = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/forecast/metadata.json', import.meta.url), 'utf8'));
const template: ForecastResponse = JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/forecast/baseline/population/${metadata.available_years[0]}.json`, import.meta.url), 'utf8'));
const definition = metadata.metrics.find(metric => metric.id === 'population')!;

function response(year: number, values: (number | null)[], bases: (number | null)[] = values.map(() => 100)): ForecastResponse {
  const forecast = structuredClone(template);
  forecast.base_year = 2026;
  forecast.forecast_year = year;
  forecast.geojson.features = values.map((value, index) => {
    const feature = structuredClone(template.geojson.features[index]);
    const baseline = bases[index];
    feature.id = `district-${index}`;
    feature.properties = { ...feature.properties, feature_id: feature.id, name: `Район ${index + 1}`, baseline_value: baseline, forecast_value: value,
      delta_absolute: baseline === null || value === null ? null : value - baseline,
      delta_percent: baseline === null || value === null || baseline === 0 ? null : (value - baseline) / baseline * 100,
      quality_status: baseline === null ? value === null ? 'missing_both' : 'missing_baseline' : value === null ? 'missing_forecast' : 'ok', unit: 'persons' };
    return feature;
  });
  const observed = values.filter((value): value is number => value !== null);
  forecast.aggregates = { ...forecast.aggregates, baseline_value: bases.filter((value): value is number => value !== null).reduce((a, b) => a + b, 0), forecast_value: observed.length ? observed.reduce((a, b) => a + b, 0) : null,
    feature_count: values.length, forecast_observed_count: observed.length, coverage_comparable: values.every((value, index) => (value === null) === (bases[index] === null)) };
  return forecast;
}

function chart(forecast: ForecastResponse, series: ForecastResponse[], selectedId = 'district-0') {
  return renderToStaticMarkup(<ForecastComparison forecast={forecast} series={series} definition={definition} selectedId={selectedId} selectedName="Район 1" onSelect={() => {}} onYearSelect={() => {}} changeMode="absolute" scale={changeScale(series, definition, 'absolute')} />);
}

describe('minimal forecast charts', () => {
  it('separates missing baseline from an observed zero', () => {
    const forecast = response(2028, [0], [null]);
    const html = chart(forecast, [forecast]);
    expect(html).toContain('Базовый, 2026: Нет данных чел.');
    expect(html).toContain('Выбранный, 2028: 0 чел.');
    expect(html).toContain('Изменение: <strong>Не определено</strong>');
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
  });

  it('uses calendar distance on the dynamics axis, including an uneven year series', () => {
    const series = [response(2026, [100]), response(2027, [110]), response(2030, [120])];
    const html = chart(series[1], series);
    expect(html).toContain('data-year="2027" style="left:25%;');
    expect(html).toContain('data-year="2030" style="left:100%;');
    expect(html).not.toContain('left:50%;top:50%');
    expect(html).toContain('forecast-trend-axis');
  });

  it('breaks the selected-object line at missing values without zero filling', () => {
    const series = [response(2026, [100]), response(2027, [null]), response(2030, [120])];
    const html = chart(series[2], series);
    expect(html).not.toContain('<polyline');
    expect(html).not.toContain('data-year="2027"');
    expect(html).toContain('Выбрать 2027 год: Нет данных чел.');
    expect(html).toContain('Разрыв линии — отсутствующее значение.');
  });

  it('breaks aggregate lines when observed identities change even at the same observation count', () => {
    const series = [response(2026, [100, null]), response(2027, [null, 120]), response(2030, [null, 130])];
    const html = chart(series[2], series, '');
    expect((html.match(/<polyline/g) ?? []).length).toBe(1);
    expect(html).toContain('Состав наблюдений меняется.');
  });

  it('draws decline to the left and growth to the right of zero with a fixed cross-year scale', () => {
    const series = [response(2027, [120, 90]), response(2030, [140, 80])];
    const html = chart(series[0], series);
    expect(html).toContain('left:50%;width:25%');
    expect(html).toContain('left:37.5%;width:12.5%');
    expect(html).toContain('data-feature-id="district-0"');
    expect(html).toContain('data-feature-id="district-1"');
    expect(html).toContain('aria-pressed="true" data-feature-id="district-0"');
    const future = chart(series[1], series);
    expect(future).toContain('left:50%;width:50%');
    expect(future).toContain('left:25%;width:25%');
  });

  it('keeps unavailable reference-object charts empty rather than using regional totals', () => {
    const forecast = response(2028, [120]);
    const html = chart(forecast, [forecast], 'stop-without-values');
    expect((html.match(/Значения не предоставлены/g) ?? []).length).toBe(2);
    expect(html).not.toContain('class="forecast-column ');
    expect(html).not.toContain('class="forecast-trend-point ');
  });
});
