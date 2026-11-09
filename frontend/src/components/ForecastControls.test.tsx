import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ForecastMetadata } from '../data/forecast-client';
import type { CriticalInterval } from '../forecast/presentation';
import { ForecastControls } from './ForecastControls';

const metadata: ForecastMetadata = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/forecast/metadata.json', import.meta.url), 'utf8'));
const baseProps = {
  metadata: null, selection: null, onChange: () => {}, intervals: [],
  selectedInterval: null, onIntervalSelect: () => {}, loading: false, hasError: false,
  showDemo: true, canReload: true, onReload: () => {},
};

describe('forecast timeline', () => {
  it('distinguishes a failed interval request from an empty provider schedule', () => {
    const failed = renderToStaticMarkup(<ForecastControls {...baseProps} hasError />);
    expect(failed).toContain('Критические интервалы не загружены. Повторите запрос.');
    expect(failed).not.toContain('Критических интервалов в данных поставщика нет.');
    expect(failed).toContain('Нет доступных лет');
    expect(failed).not.toContain('Загрузка…');
    const empty = renderToStaticMarkup(<ForecastControls {...baseProps} metadata={metadata} selection={{ year: metadata.base_year, metric: 'population', scenario: 'baseline' }} />);
    expect(empty).toContain('Критических интервалов в данных поставщика нет.');
  });

  it('keeps only the year timeline in the sticky header', () => {
    const html = renderToStaticMarkup(<ForecastControls {...baseProps} metadata={metadata} selection={{ year: metadata.base_year, metric: 'population', scenario: 'baseline' }} />);
    expect(html).toContain('type="range"');
    expect(html).not.toContain('<select');
    expect(html).not.toContain('Базовый год');
    expect(html).not.toContain('Показатель');
    expect(html).not.toContain('Сценарий');
    expect(html).not.toContain('Обновить данные');
    // The continuously visible demo notice is owned by the workspace, not the
    // slider-only header; it must not introduce a second header row.
    expect(html).not.toContain('Demo data. Analytical model not connected.');
  });

  it('renders every metadata year without a fixed calendar range', () => {
    const catalog = structuredClone(metadata);
    catalog.base_year = 2018;
    catalog.available_years = [2018, 2022, 2057];
    const html = renderToStaticMarkup(<ForecastControls {...baseProps} metadata={catalog} selection={{ year: 2022, metric: 'population', scenario: 'baseline' }} />);
    for (const year of catalog.available_years) expect(html).toContain(`Выбрать ${year} год`);
    expect(html).toContain('max="2"');
    expect(html).toContain('step="1"');
    expect(html).toContain('aria-valuetext="2022 год"');
    expect(html).not.toContain('Выбрать 2030 год');
  });

  it('places only provider critical intervals on the same slider track', () => {
    const catalog = { ...metadata, base_year: 2026, available_years: [2026, 2027, 2028, 2029, 2030] };
    const interval: CriticalInterval = { start_year: 2027, end_year: 2029, severity: 'high', metric: 'population', affected_feature_ids: ['district-1'], trigger_description: 'Причина от модели', recommended_action: 'Действие от модели' };
    const html = renderToStaticMarkup(<ForecastControls {...baseProps} metadata={catalog} selection={{ year: 2028, metric: 'population', scenario: 'baseline' }} intervals={[interval]} />);
    for (const year of catalog.available_years) expect(html).toContain(`Выбрать ${year} год`);
    expect(html).toContain('Критический интервал 2027–2029. Высокая значимость.');
    expect(html).toContain('timeline-interval');
    expect(html).toContain('timeline-critical-marker');
    expect(html).not.toContain('interval-scale');
    const trackStart = html.indexOf('class="timeline-track"');
    const ticksStart = html.indexOf('class="timeline-years"');
    expect(html.indexOf('timeline-critical-marker')).toBeGreaterThan(trackStart);
    expect(html.indexOf('timeline-critical-marker')).toBeLessThan(ticksStart);
    const noIntervals = renderToStaticMarkup(<ForecastControls {...baseProps} metadata={catalog} selection={{ year: 2028, metric: 'population', scenario: 'baseline' }} />);
    expect(noIntervals).not.toContain('timeline-critical-marker');
  });
});
