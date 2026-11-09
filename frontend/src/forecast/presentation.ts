import type { ForecastMetadata, ForecastResponse } from '../data/forecast-client';
import { ForecastDataError } from '../data/forecast-client';

export type ForecastFeature = ForecastResponse['geojson']['features'][number];
export type CriticalInterval = ForecastResponse['critical_intervals'][number];
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

export function formatValue(value: number | null | undefined): string {
  return value == null ? 'Нет данных' : number.format(value);
}

export function formatDelta(value: number | null | undefined): string {
  return value == null ? 'Не определено' : `${value > 0 ? '+' : ''}${number.format(value)}`;
}

export function unitLabel(unit: string): string {
  return ({ persons: 'чел.', 'trips/day': 'поездок/сутки', '%': '%' } as Record<string, string>)[unit] ?? unit;
}

export function deltaUnitLabel(unit: string): string {
  return unit === '%' ? 'п.п.' : unitLabel(unit);
}

export function summaryForSelection(forecast: ForecastResponse | null, selectedId: string) {
  if (!forecast) return undefined;
  if (!selectedId) return forecast.aggregates;
  const properties = forecast.geojson.features.find(feature => feature.id === selectedId)?.properties;
  const baseline = properties?.baseline_value ?? null;
  const predicted = properties?.forecast_value ?? null;
  return {
    ...forecast.aggregates, feature_count: 1,
    baseline_value: baseline, forecast_value: predicted,
    delta_absolute: properties?.delta_absolute ?? null, delta_percent: properties?.delta_percent ?? null,
    baseline_observed_count: baseline === null ? 0 : 1, forecast_observed_count: predicted === null ? 0 : 1,
    paired_observed_count: baseline !== null && predicted !== null ? 1 : 0,
    coverage_comparable: baseline !== null && predicted !== null,
  };
}

export function qualityLabel(status: string): string {
  return ({ ok: 'Данные есть', missing_baseline: 'Нет базового значения', missing_forecast: 'Нет значения прогноза', missing_both: 'Нет данных за оба года' } as Record<string, string>)[status] ?? status;
}

export const severityLabels: Record<CriticalInterval['severity'], string> = {
  low: 'Низкая значимость', medium: 'Средняя значимость', high: 'Высокая значимость', critical: 'Критическая значимость',
};

export function intervalKey(interval: CriticalInterval, index: number): string {
  return `${index}:${interval.metric}:${interval.start_year}:${interval.end_year}:${interval.affected_feature_ids.join(',')}`;
}

// The range control steps only through metadata years. Interpolate calendar
// windows between these discrete ticks, including unevenly spaced years.
export function yearPosition(year: number, years: readonly number[]): number {
  if (years.length < 2 || year <= years[0]) return 0;
  if (year >= years[years.length - 1]) return 1;
  const right = years.findIndex(available => available >= year);
  return (right - 1 + (year - years[right - 1]) / (years[right] - years[right - 1])) / (years.length - 1);
}

export function initialSelection(metadata: ForecastMetadata) {
  return {
    year: metadata.base_year,
    metric: metadata.metrics[0]?.id ?? '', scenario: metadata.scenarios[0]?.id ?? '',
  };
}

export function chartDomain(values: (number | null)[]): [number, number] {
  const observed = values.filter((value): value is number => value !== null);
  const min = Math.min(0, ...observed);
  const max = Math.max(0, ...observed);
  return min === max ? [0, 1] : [min, max];
}

export function barGeometry(value: number, [min, max]: [number, number]) {
  return { left: `${(Math.min(0, value) - min) / (max - min) * 100}%`, width: `${Math.abs(value) / (max - min) * 100}%` };
}

export function errorLabel(error: unknown, mode: 'demo' | 'api' | undefined): string {
  if (error instanceof ForecastDataError) {
    if (error.status === 503) return 'Поставщик прогнозных данных временно недоступен. Повторите запрос.';
    if (error.status === 422) return 'Поставщик не поддерживает выбранные параметры. Обновите данные и выберите доступные значения.';
    if (error.message.includes('contract') || error.message.includes('identity/provenance') || error.message.includes('is_demo')) {
      return 'Полученные данные не соответствуют контракту или выбранным параметрам. Повторите запрос.';
    }
  }
  return mode === 'api'
    ? 'Сервис прогнозных данных недоступен. Проверьте подключение и повторите запрос.'
    : 'Не удалось загрузить демонстрационные данные. Повторите запрос.';
}
