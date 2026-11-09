import type { ForecastResponse } from '../data/forecast-client';
import { chartDomain, deltaUnitLabel, formatDelta, formatValue, unitLabel } from '../forecast/presentation';
import { changeColor, changeValue, type ChangeMode, type ChangeScale, type MetricDefinition } from '../forecast/map-model';
import './forecast-charts.css';

type Props = {
  forecast: ForecastResponse; series: ForecastResponse[]; definition: MetricDefinition | undefined;
  selectedId: string; selectedName: string; onSelect: (id: string) => void; onYearSelect: (year: number) => void;
  changeMode: ChangeMode; scale: ChangeScale;
};

function observedIds(response: ForecastResponse) {
  return response.geojson.features.filter(feature => feature.properties.forecast_value !== null).map(feature => feature.id).sort().join('|');
}

export function ForecastComparison({ forecast, series, definition, selectedId, selectedName, onSelect, onYearSelect, changeMode, scale }: Props) {
  const selected = forecast.geojson.features.find(feature => feature.id === selectedId);
  const unit = unitLabel(forecast.aggregates.unit);
  const changeUnit = changeMode === 'percent' ? '%' : deltaUnitLabel(forecast.aggregates.unit);
  const baseline = selectedId ? selected?.properties.baseline_value ?? null : forecast.aggregates.baseline_value;
  const predicted = selectedId ? selected?.properties.forecast_value ?? null : forecast.aggregates.forecast_value;
  const delta = selectedId ? selected ? changeValue(selected, changeMode) : null
    : changeMode === 'percent' ? forecast.aggregates.delta_percent : forecast.aggregates.delta_absolute;
  const scope = selectedId ? selectedName : 'Все объекты';
  const aggregationLabel = !selectedId ? definition?.aggregation === 'mean' ? 'Среднее' : 'Сумма известных значений' : '';
  const [pairMin, pairMax] = chartDomain([baseline, predicted]);
  const pairSpan = pairMax - pairMin;
  const pairY = (value: number) => (pairMax - value) / pairSpan * 100;
  const pairZero = pairY(0);
  const dynamics = [...series].sort((a, b) => a.forecast_year - b.forecast_year).map(response => ({
    year: response.forecast_year,
    value: selectedId ? response.geojson.features.find(feature => feature.id === selectedId)?.properties.forecast_value ?? null : response.aggregates.forecast_value,
    observed: observedIds(response), count: response.aggregates.forecast_observed_count,
  }));
  const values = dynamics.flatMap(point => point.value === null ? [] : [point.value]);
  // The line shows change with explicitly labelled limits, whereas comparison
  // columns always start at zero. Missing observations never become zero.
  const observedMin = values.length ? Math.min(...values) : 0;
  const observedMax = values.length ? Math.max(...values) : 0;
  const padding = observedMax === observedMin ? Math.max(Math.abs(observedMin) * .01, 1) : (observedMax - observedMin) * .12;
  const trendMin = observedMin >= 0 ? Math.max(0, observedMin - padding) : observedMin - padding;
  const trendMax = observedMax + padding;
  const trendY = (value: number) => (trendMax - value) / (trendMax - trendMin) * 100;
  const firstYear = dynamics[0]?.year ?? forecast.base_year;
  const lastYear = dynamics[dynamics.length - 1]?.year ?? firstYear;
  const trendX = (year: number) => firstYear === lastYear ? 50 : (year - firstYear) / (lastYear - firstYear) * 100;
  const segments: string[][] = [[]];
  let coverageChanges = false;
  dynamics.forEach((point, index) => {
    if (!selectedId && index > 0 && point.observed !== dynamics[index - 1].observed) {
      coverageChanges = true;
      if (segments[segments.length - 1].length) segments.push([]);
    }
    if (point.value === null) { if (segments[segments.length - 1].length) segments.push([]); }
    else segments[segments.length - 1].push(`${trendX(point.year)},${trendY(point.value)}`);
  });
  const ranked = forecast.geojson.features
    .map(feature => ({ feature, delta: changeValue(feature, changeMode) }))
    .filter((item): item is { feature: NonNullable<typeof selected>; delta: number } => item.delta !== null)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.feature.id.localeCompare(b.feature.id));
  const maxChange = Math.max(1, scale.positiveMax, scale.negativeMax);

  return <div className="forecast-charts">
    <figure className="forecast-chart forecast-pair">
      <figcaption><h3>Базовый / выбранный год</h3><p className="forecast-chart-scope">{scope}</p><span>{aggregationLabel && `${aggregationLabel} · `}{unit}</span></figcaption>
      {baseline === null && predicted === null ? <p className="forecast-chart-empty">Значения не предоставлены</p> : <div className="forecast-column-area">
        <div className="forecast-column-axis" aria-hidden="true">{pairMax !== 0 && <span>{formatValue(pairMax)}</span>}<span style={{ top: `${pairZero}%` }}>0</span>{pairMin < 0 && <span style={{ top: '100%' }}>{formatValue(pairMin)}</span>}</div>
        <div className="forecast-column-plot">
          <span className="forecast-zero-line" style={{ top: `${pairZero}%` }} />
          {[{ year: forecast.base_year, value: baseline, role: 'base', label: 'Базовый' }, { year: forecast.forecast_year, value: predicted, role: 'forecast', label: 'Выбранный' }].map(point => <button key={point.role} className={`forecast-column ${point.role}`} onClick={() => onSelect(selectedId)} disabled={!selectedId}
            aria-label={`${scope}. ${point.label}, ${point.year}: ${formatValue(point.value)} ${unit}${selectedId ? '. Выделить объект на карте' : ''}`}>
            {point.value !== null && <span className="forecast-column-fill" style={{ top: `${Math.min(pairY(point.value), pairZero)}%`, height: `${Math.abs(point.value) / pairSpan * 100}%` }} />}
            <strong className={`forecast-column-value ${point.value !== null && point.value < 0 ? 'negative' : ''}`} style={{ top: `${point.value === null ? pairZero : pairY(point.value)}%` }}>{formatValue(point.value)}</strong>
            <span className="forecast-column-year">{point.year}<small>{point.label}</small></span>
          </button>)}
        </div>
      </div>}
      <p className="forecast-chart-delta">Изменение: <strong>{formatDelta(delta)}{delta === null ? '' : ` ${changeUnit}`}</strong></p>
      {!selectedId && !forecast.aggregates.coverage_comparable && <p className="forecast-chart-warning">Разный состав наблюдений. Итоги неполные; общее изменение не определено.</p>}
      {!selectedId && definition?.aggregation === 'mean' && <p className="forecast-chart-note">Проценты загрузки не суммируются.</p>}
    </figure>

    <figure className="forecast-chart forecast-dynamics">
      <figcaption><h3>Динамика по годам</h3><p className="forecast-chart-scope">{scope}</p><span>{unit}</span></figcaption>
      {values.length === 0 ? <p className="forecast-chart-empty">Значения не предоставлены</p> : <div className="forecast-trend-area">
        <div className="forecast-trend-axis" aria-hidden="true"><span>{formatValue(trendMax)}</span><span>{formatValue((trendMin + trendMax) / 2)}</span><span>{formatValue(trendMin)}</span></div>
        <div className="forecast-trend-plot">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {[0, 50, 100].map(y => <line key={y} x1="0" x2="100" y1={y} y2={y} className="forecast-trend-grid" />)}
            {segments.filter(segment => segment.length > 1).map((segment, index) => <polyline key={index} points={segment.join(' ')} fill="none" stroke="#3a7199" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
          </svg>
          {dynamics.map(point => point.value === null ? null : <button key={point.year} className={`forecast-trend-point ${point.year === forecast.forecast_year ? 'selected' : ''}`} data-year={point.year}
            style={{ left: `${trendX(point.year)}%`, top: `${trendY(point.value)}%` }} onClick={() => onYearSelect(point.year)} aria-pressed={point.year === forecast.forecast_year}
            aria-label={`Выбрать ${point.year} год: ${formatValue(point.value)} ${unit}. ${scope}`} />)}
        </div>
      </div>}
      <div className="forecast-year-values">{dynamics.map(point => <button key={point.year} onClick={() => onYearSelect(point.year)} aria-pressed={point.year === forecast.forecast_year} aria-label={`Выбрать ${point.year} год: ${formatValue(point.value)} ${unit}`}>
        <strong>{point.year}</strong><span>{formatValue(point.value)}</span>{!selectedId && <small>{point.count} объектов</small>}
      </button>)}</div>
      {coverageChanges && <p className="forecast-chart-warning">Состав наблюдений меняется. Между несопоставимыми годами линия разорвана.</p>}
      {values.length > 0 && dynamics.some(point => point.value === null) && <p className="forecast-chart-note">Разрыв линии — отсутствующее значение.</p>}
    </figure>

    <figure className="forecast-chart forecast-ranking">
      <figcaption><h3>Наибольшее изменение</h3><span>{changeMode === 'percent' ? 'Процентное' : 'Абсолютное'} изменение к {forecast.base_year} году · {changeUnit}</span></figcaption>
      {ranked.length > 0 && <div className="forecast-ranking-axis" aria-hidden="true"><span>Снижение</span><span>0</span><span>Рост</span></div>}
      <ol>{ranked.slice(0, 10).map(({ feature, delta }) => {
        const width = Math.abs(delta) / maxChange * 50;
        return <li key={feature.id}><button className={selectedId === feature.id ? 'selected' : ''} onClick={() => onSelect(feature.id)} aria-pressed={selectedId === feature.id} data-feature-id={feature.id}>
          <span className="forecast-ranking-name">{feature.properties.name}</span>
          <span className="forecast-ranking-track" aria-hidden="true"><span className="forecast-ranking-zero" />{delta === 0 ? <i className="forecast-ranking-no-change" /> : <i className="forecast-ranking-bar" style={{ left: `${delta < 0 ? 50 - width : 50}%`, width: `${width}%`, background: changeColor(delta, scale, feature) }} />}</span>
          <strong>{formatDelta(delta)} {changeUnit}</strong>
        </button></li>;
      })}</ol>
      {ranked.length === 0 && <p className="forecast-chart-empty">Нет определённых изменений</p>}
      {ranked.length < forecast.geojson.features.length && <p className="forecast-chart-note">Без сравнимого изменения: {forecast.geojson.features.length - ranked.length}. Пропуски и проценты при нулевой базе исключены из рейтинга.</p>}
    </figure>
  </div>;
}
