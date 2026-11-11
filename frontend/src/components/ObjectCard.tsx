import { MapPin } from 'lucide-react';
import type { ForecastMetadata, ForecastResponse } from '../data/forecast-client';
import { geographyFeatures, geometryLabel } from '../forecast/map-model';
import { deltaUnitLabel, formatDelta, formatValue, intervalKey, qualityLabel, severityLabels, unitLabel, type CriticalInterval } from '../forecast/presentation';

type Props = { metadata: ForecastMetadata | null; forecast: ForecastResponse | null; selectedId: string; districtAsReference?: boolean; intervals: CriticalInterval[]; onIntervalSelect: (key: string) => void };

export function ObjectCard({ metadata, forecast, selectedId, districtAsReference, intervals, onIntervalSelect }: Props) {
  const object = geographyFeatures(metadata).find(feature => feature.id === selectedId);
  if (!object) return <p className="detail-hint">Выберите объект на карте, в строке или столбце графика либо в таблице. Выбор синхронизирован во всех представлениях.</p>;
  if (districtAsReference) return <div className="territory-detail object-card" aria-label="Карточка выбранного района">
    <h3><MapPin size={15} aria-hidden="true" />{object.properties.name}</h3>
    <p className="detail-hint">Район выделен на карте. Для значений отдельного объекта выберите его на карте или в списке.</p>
  </div>;
  const properties = forecast?.geojson.features.find(feature => feature.id === selectedId)?.properties;
  const unit = properties ? unitLabel(properties.unit) : '—';
  const associated = intervals.map((interval, index) => ({ interval, key: intervalKey(interval, index) })).filter(item => item.interval.affected_feature_ids.includes(selectedId));
  return <div className="territory-detail object-card" aria-label="Карточка выбранного объекта">
    <h3><MapPin size={15} aria-hidden="true" />{object.properties.name}</h3><p className="object-kind">{geometryLabel(object.geometry.type)}</p>
    <dl>
      <div><dt>Базовый, {forecast?.base_year ?? metadata?.base_year}</dt><dd>{formatValue(properties?.baseline_value)}{properties?.baseline_value != null && ` ${unit}`}</dd></div>
      <div><dt>Прогноз, {forecast?.forecast_year ?? '—'}</dt><dd>{formatValue(properties?.forecast_value)}{properties?.forecast_value != null && ` ${unit}`}</dd></div>
      <div><dt>Абсолютное изменение</dt><dd>{formatDelta(properties?.delta_absolute)}{properties?.delta_absolute != null && ` ${deltaUnitLabel(properties.unit)}`}</dd></div>
      <div><dt>Процентное изменение</dt><dd>{formatDelta(properties?.delta_percent)}{properties?.delta_percent != null && ' %'}</dd></div>
      <div><dt>Единица показателя</dt><dd>{unit}</dd></div>
      <div><dt>Качество данных</dt><dd>{properties ? qualityLabel(properties.quality_status) : forecast ? 'Значения для этого объекта не предоставлены' : 'Данные не загружены'}</dd></div>
    </dl>
    {properties?.baseline_value === 0 && <p className="quality-text">Базовое значение равно нулю: процентное изменение не определено, абсолютное показано отдельно.</p>}
    {!properties && forecast && <p className="quality-text">Справочный объект не участвует в агрегировании выбранного показателя. Отсутствие значений не означает нулевую нагрузку.</p>}
    <div className="object-intervals"><strong>Критические интервалы объекта</strong>{associated.length ? associated.map(({ interval, key }) => <details key={key}><summary>{interval.start_year}–{interval.end_year} · {severityLabels[interval.severity]}</summary><p><b>Причина:</b> {interval.trigger_description}</p><p><b>Действие:</b> {interval.recommended_action}</p><button onClick={() => onIntervalSelect(key)}>Выделить связанные объекты на карте</button></details>) : <p>Поставщик не указал интервалов для этого объекта.</p>}</div>
  </div>;
}
