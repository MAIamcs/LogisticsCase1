import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Database, Route } from 'lucide-react';
import { ForecastControls } from './components/ForecastControls';
import { ForecastMap, type LayerVisibility } from './components/ForecastMap';
import { MapParameters } from './components/MapParameters';
import { ForecastComparison } from './components/ForecastComparison';
import { ObjectCard } from './components/ObjectCard';
import { ChangeLegend } from './components/ChangeLegend';
import { changeScale, geographyFeatures, type ChangeMode } from './forecast/map-model';
import { useForecastWorkspace } from './forecast/useForecastWorkspace';
import { linkedFeature, workspaceLink } from './forecast/workspace-link';
import type { ForecastSelection } from './data/forecast-client';
import './city-workspace.css';
import { deltaUnitLabel, formatDelta, formatValue, intervalKey, qualityLabel, severityLabels, summaryForSelection, unitLabel } from './forecast/presentation';

export function App() {
  const workspace = useForecastWorkspace();
  const { metadata, selection, result, loading, error } = workspace;
  const [selectedId, setSelectedId] = useState(() => linkedFeature(window.location.search));
  const [changeMode, setChangeMode] = useState<ChangeMode>('absolute');
  const [visibility, setVisibility] = useState<LayerVisibility>({ stops: false });
  const [selectedIntervalKey, setSelectedIntervalKey] = useState<string | null>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const intervalDetailsRef = useRef<HTMLDivElement>(null);
  const forecast = result?.forecast ?? null;
  const intervals = result?.horizon.critical_intervals ?? [];
  const interval = intervals.find((item, index) => intervalKey(item, index) === selectedIntervalKey);
  const affectedIds = interval?.affected_feature_ids ?? [];

  const definition = metadata?.metrics.find(metric => metric.id === selection?.metric);
  const scale = useMemo(() => changeScale(result?.series ?? [], definition, changeMode), [result?.series, definition, changeMode]);
  const unit = unitLabel(definition?.unit ?? '');
  const deltaUnit = deltaUnitLabel(definition?.unit ?? '');
  const showDemo = workspace.mode === 'demo' || metadata?.is_demo === true || forecast?.is_demo === true;
  const names = new Map(geographyFeatures(metadata).map(feature => [feature.id, feature.properties.name]));
  const aggregates = summaryForSelection(forecast, selectedId);
  function selectParameters(next: ForecastSelection) {
    if (next.metric !== selection?.metric && selectedId && metadata) {
      const object = geographyFeatures(metadata).find(feature => feature.id === selectedId);
      const target = metadata.metrics.find(metric => metric.id === next.metric);
      if (object && target && !target.geometry_types.includes(object.geometry.type)) setSelectedId('');
    }
    workspace.setSelection(next);
  }

  useEffect(() => { setSelectedIntervalKey(null); }, [selection?.metric, selection?.scenario]);
  useEffect(() => {
    if (selectedIntervalKey) {
      intervalDetailsRef.current?.scrollIntoView({ block: window.matchMedia('(max-width: 580px)').matches ? 'start' : 'nearest', behavior: 'instant' });
    }
  }, [selectedIntervalKey]);
  useEffect(() => {
    if (selectedId && metadata && !geographyFeatures(metadata).some(feature => feature.id === selectedId)) setSelectedId('');
  }, [metadata, selectedId]);
  useEffect(() => {
    if (!metadata || !selection) return;
    const link = workspaceLink(window.location.href, metadata, selection, selectedId);
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== link) window.history.replaceState(null, '', link);
  }, [metadata, selection, selectedId]);
  useEffect(() => {
    if (!controlsRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      document.documentElement.style.setProperty('--controls-height', `${entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height}px`);
    });
    observer.observe(controlsRef.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--controls-height'); };
  }, []);

  return <div className="city-workspace">
    <a className="skip-link" href="#main-content">Перейти к карте и показателям</a>
    <header className="page-header page-width">
      <div className="project-label"><Route size={18} aria-hidden="true" /><span>Новосибирск · 10 районов</span></div>
      <h1>Транспортное планирование</h1>

    </header>

    <div ref={controlsRef} className="sticky-host">
      <ForecastControls metadata={metadata} selection={selection} onChange={workspace.setSelection} intervals={intervals} selectedInterval={selectedIntervalKey} onIntervalSelect={setSelectedIntervalKey} loading={loading} hasError={Boolean(error)} showDemo={showDemo} canReload={workspace.canReload} onReload={workspace.reload} />
    </div>

    <main id="main-content" className="page-width main-content" tabIndex={-1}>
      <div className="request-state" role="status" aria-live="polite" aria-atomic="true">
        {loading ? 'Загрузка выбранного прогноза…' : error ? 'Данные не загружены.' : forecast ? `Загружены данные: ${definition?.name}, ${selection?.year} год. ${forecast.geojson.features.length} объектов.` : 'Выберите доступные параметры.'}
      </div>
      {error && <div className="error-box" role="alert"><AlertCircle size={20} aria-hidden="true" /><div><strong>Не удалось загрузить данные</strong><p>{error}</p>{workspace.canReload && <button onClick={workspace.reload}>Повторить запрос <ArrowRight size={15} /></button>}</div></div>}

      <section className="map-section" aria-labelledby="map-heading" aria-busy={loading}>
        <div className="section-heading"><div><h2 id="map-heading">Карта Новосибирска</h2><p>{definition ? `${definition.name} · ${selection?.year} год · ${unit}` : loading ? 'Границы и значения загружаются из описания набора данных' : 'Данные карты недоступны'}</p></div><span className="section-meta">{forecast ? `${forecast.geojson.features.length} объектов` : 'Нет загруженных значений'}</span></div>

        <div className="map-layout">
          <div className="map-primary"><ForecastMap metadata={metadata} forecast={forecast} selectedId={selectedId} affectedIds={affectedIds} onSelect={setSelectedId} changeMode={changeMode} scale={scale} visibility={visibility} loadLayer={workspace.loadGeographyLayer} />{loading && <div className="map-loading" role="status">Загрузка карты показателя…</div>}</div>
          <aside className="map-details" aria-label="Объекты и критические интервалы">
            <MapParameters metadata={metadata} selection={selection} onChange={selectParameters} selectedId={selectedId} onSelect={setSelectedId} visibility={visibility} onLayerChange={(id, value) => setVisibility(current => ({ ...current, [id]: value }))} loading={loading} canReload={workspace.canReload} onReload={workspace.reload} />
            <fieldset className="change-mode"><legend>Отображать изменение</legend><label><input type="radio" name="change-mode" value="absolute" checked={changeMode === 'absolute'} onChange={() => setChangeMode('absolute')} /> Абсолютное ({deltaUnit || 'единица показателя'})</label><label><input type="radio" name="change-mode" value="percent" checked={changeMode === 'percent'} onChange={() => setChangeMode('percent')} /> Процентное (%)</label></fieldset>
            <ObjectCard metadata={metadata} forecast={forecast} selectedId={selectedId} intervals={intervals} onIntervalSelect={setSelectedIntervalKey} />

            <div className="interval-details" ref={intervalDetailsRef}><h3><i className="interval-key" aria-hidden="true" />Критические интервалы</h3>
              {intervals.length > 0 ? <><label className="sr-only" htmlFor="critical-interval-select">Выберите критический интервал</label><select id="critical-interval-select" value={selectedIntervalKey ?? ''} onChange={event => setSelectedIntervalKey(event.target.value || null)}><option value="">Выберите интервал на шкале</option>{intervals.map((item, index) => <option key={intervalKey(item, index)} value={intervalKey(item, index)}>{item.start_year}–{item.end_year} · {severityLabels[item.severity]}</option>)}</select></> : <p className="detail-hint">{loading ? 'Загрузка интервалов поставщика…' : error ? 'Интервалы недоступны из-за ошибки загрузки.' : 'В доступном горизонте поставщик не указал критических интервалов.'}</p>}
              {interval && <div className="interval-content" aria-live="polite"><strong>{interval.start_year}–{interval.end_year}</strong><span className="severity-text">{severityLabels[interval.severity]}</span><dl><div><dt>Затронутые объекты</dt><dd><ul>{interval.affected_feature_ids.map(id => <li key={id}><button onClick={() => setSelectedId(id)}>{names.get(id) ?? id}</button></li>)}</ul></dd></div><div><dt>Причина</dt><dd>{interval.trigger_description}</dd></div><div><dt>Рекомендуемое действие</dt><dd>{interval.recommended_action}</dd></div></dl></div>}
              <p className="provider-note">Интервалы и рекомендации переданы поставщиком данных. Загрузка 100% не определяет долю инфраструктуры к замене.</p>
            </div>
          </aside>
        </div>
        <ChangeLegend scale={scale} unit={changeMode === 'percent' ? '%' : deltaUnit} />
        <div className="map-legend" aria-label="Геометрия и выделение"><span><i className="legend-affected" />Критический интервал поставщика</span><span><i className="legend-selected" />Выбранный объект</span></div>
      </section>

      <section className="numbers-section" aria-labelledby="numbers-heading" aria-busy={loading}>
        <div className="section-heading"><div><h2 id="numbers-heading">Ключевые показатели</h2><p>{selectedId ? names.get(selectedId) ?? selectedId : definition?.description ?? 'Показатели появятся после загрузки данных'}</p></div></div>
        <div className="indicator-grid">
          <article className="indicator-card"><h3>Базовый год · {forecast?.base_year ?? metadata?.base_year ?? '—'}</h3><strong>{formatValue(aggregates?.baseline_value)}</strong><span>{unit || 'Единица из описания показателя'}</span><p>Есть данные: {aggregates?.baseline_observed_count ?? '—'} из {aggregates?.feature_count ?? '—'} объектов</p></article>
          <article className="indicator-card selected-indicator"><h3>Прогноз · {forecast?.forecast_year ?? selection?.year ?? '—'}</h3><strong>{formatValue(aggregates?.forecast_value)}</strong><span>{unit || 'Единица из описания показателя'}</span><p>Есть данные: {aggregates?.forecast_observed_count ?? '—'} из {aggregates?.feature_count ?? '—'} объектов</p></article>
          <article className={`indicator-card ${changeMode === 'absolute' ? 'active-mode-indicator' : ''}`}><h3>Абсолютное изменение</h3><strong>{forecast ? formatDelta(aggregates?.delta_absolute) : 'Нет данных'}</strong><span>{deltaUnit || '—'}</span><p>{!forecast ? 'Данные не загружены' : aggregates?.coverage_comparable ? selectedId ? 'Изменение выбранного объекта' : 'К базовому году, по сопоставимым объектам' : selectedId ? 'Нет сравнимых значений' : 'Состав наблюдаемых объектов различается'}</p></article>
          <article className={`indicator-card ${changeMode === 'percent' ? 'active-mode-indicator' : ''}`}><h3>Изменение к базовому году</h3><strong>{forecast ? formatDelta(aggregates?.delta_percent) : 'Нет данных'}</strong><span>%</span><p>{!forecast ? 'Данные не загружены' : aggregates?.baseline_value === 0 ? 'Процент не определён при нулевом базовом значении' : aggregates?.coverage_comparable ? selectedId ? 'Изменение выбранного объекта' : 'По сопоставимым объектам' : selectedId ? 'Нет сравнимых значений' : 'Не рассчитывается при различающейся полноте данных'}</p></article>
        </div>
      </section>

      <section className="comparison-section" aria-labelledby="comparison-heading" aria-busy={loading}>
        <div className="section-heading"><div><h2 id="comparison-heading">Сравнение годов</h2><p>Базовый и выбранный год. Пропуски обозначены текстом и не заменяются нулями.</p></div></div>
        {forecast ? <><ForecastComparison forecast={forecast} series={result!.series} definition={definition} selectedId={selectedId} selectedName={names.get(selectedId) ?? selectedId} onSelect={setSelectedId} onYearSelect={year => selection && workspace.setSelection({ ...selection, year })} changeMode={changeMode} scale={scale} /><div className="table-scroll" role="region" aria-label="Таблица сравнения объектов; при необходимости прокрутите горизонтально" tabIndex={0}><table><caption>Значения по объектам · {unit}</caption><thead><tr><th scope="col">Объект</th><th scope="col">{forecast.base_year}, базовый</th><th scope="col">{forecast.forecast_year}, прогноз</th><th scope="col">Изменение, {deltaUnit}</th><th scope="col">Изменение, %</th><th scope="col">Полнота данных</th></tr></thead><tbody>{forecast.geojson.features.map(feature => <tr key={feature.id} className={selectedId === feature.id ? 'selected-row' : ''}><th scope="row"><button onClick={() => setSelectedId(feature.id)} aria-pressed={selectedId === feature.id}>{feature.properties.name}</button></th><td>{formatValue(feature.properties.baseline_value)}</td><td>{formatValue(feature.properties.forecast_value)}</td><td>{formatDelta(feature.properties.delta_absolute)}</td><td>{formatDelta(feature.properties.delta_percent)}</td><td className="quality-cell">{qualityLabel(feature.properties.quality_status)}</td></tr>)}</tbody></table></div></> : <div className="section-placeholder">{loading ? 'Загрузка сравнительных показателей…' : 'Нет загруженных данных для сравнения. Повторите запрос.'}</div>}
      </section>

      <footer className="sources-section" aria-labelledby="sources-heading">
        <div className="section-heading"><div><h2 id="sources-heading"><Database size={18} aria-hidden="true" />Источники и ограничения</h2></div></div>
        <dl className="source-grid"><div><dt>Источник</dt><dd>{showDemo ? 'Синтетическая демонстрационная статистика' : metadata ? 'Подключённый поставщик прогнозных данных' : 'Описание источника не загружено'}</dd></div><div><dt>Версия данных</dt><dd>{forecast?.data_version ?? metadata?.data_version ?? 'Нет данных'}</dd></div><div><dt>Версия модели</dt><dd>{forecast?.model_version ?? 'Нет данных'}</dd></div><div><dt>Базовый год из набора</dt><dd>{metadata?.base_year ?? 'Нет данных'}</dd></div></dl>
        <p className="source-disclaimer">{forecast?.disclaimer ?? metadata?.disclaimer ?? (showDemo ? 'Демонстрационные данные не являются прогнозом. Аналитическая модель не подключена.' : 'Ограничения поставщика появятся после загрузки описания набора.')}</p>
        {metadata && <p className="source-geography">География: {metadata.geography.description} Координаты — WGS84 (долгота, широта).</p>}
        <div id="map-attribution" className="map-provider-terms"><h3>Источники геоданных</h3>
          <p>Версия географии: {metadata?.geography.geography_version ?? 'Не загружена'}. {metadata?.geography.description}</p>
          {metadata?.geography.sources?.map(source => <p key={source.id}><a href={/^https?:\/\//.test(source.url) ? source.url : undefined} target="_blank" rel="noreferrer">{source.name}</a> · {source.attribution}. {source.license}{source.license_url && <> · <a href={/^https?:\/\//.test(source.license_url) ? source.license_url : undefined} target="_blank" rel="noreferrer">Условия использования</a></>}.</p>)}
          <p>Отображение: <a href="https://maplibre.org/" target="_blank" rel="noreferrer">MapLibre GL JS</a>, BSD-3-Clause. Реальная география и демонстрационные значения имеют отдельные источники. Подсветка использует исходные контуры районов.</p>
        </div>
        <p className="source-limits">Итоги учитывают только известные значения. Если состав наблюдаемых объектов различается, общее изменение не определяется. Нулевое значение отличается от отсутствующего. Решения о вмешательстве требуют проверки исходных данных и выводов аналитической модели.</p>
        {forecast && <details className="quality-warnings"><summary>Предупреждения о качестве данных ({forecast.warnings.length})</summary>{forecast.warnings.length ? <ul>{forecast.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><strong>{warning.severity === 'warning' ? 'Внимание. ' : 'Сведения. '}</strong>{warning.message}{warning.feature_ids.length > 0 && <span> Территории: {warning.feature_ids.map(id => names.get(id) ?? id).join('; ')}.</span>}</li>)}</ul> : <p>Поставщик не передал предупреждений о качестве данных.</p>}</details>}
        <div className="footer-line"><span>Транспортное планирование · Новосибирск</span><span>Контракт данных {forecast?.schema_version ?? metadata?.schema_version ?? '—'}</span></div>
      </footer>
    </main>
    {showDemo && <small className="persistent-demo" role="note">Demo data. Analytical model not connected.</small>}
  </div>;
}
