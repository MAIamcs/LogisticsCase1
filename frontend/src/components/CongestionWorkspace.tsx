import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertCircle, RefreshCw, Route } from 'lucide-react';
import type { ModelMetadata, ModelPredictionResponse } from '../data/model-client';
import { modelFeatureNames } from '../data/model-client';
import { changeScale, type MapCatalog } from '../forecast/map-model';
import { featuresFromDraft, initialModelDraft, type ModelDraft } from '../model/form';
import { useCongestionModel } from '../model/useCongestionModel';
import { ForecastMap, type LayerVisibility } from './ForecastMap';
import './congestion-workspace.css';
import districtProfiles from '../../../contracts/model-profiles.json';

const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });
const noAffectedObjects: string[] = [];
const emptyScale = changeScale([], undefined, 'absolute');
const emptyVisibility: LayerVisibility = { forecast: false, districts: true, stops: false, buildings: false };
const formatPrediction = (value: number) => number.format(value);
const formatHour = (hour: number) => `${String(hour).padStart(2, '0')}:00`;

type FormProps = {
  metadata: ModelMetadata; draft: ModelDraft; onChange: (draft: ModelDraft) => void;
  onSubmit: () => void; predicting: boolean;
};

export function CongestionForm({ metadata, draft, onChange, onSubmit, predicting }: FormProps) {
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); onSubmit(); }
  return <form className="congestion-form" onSubmit={submit}>
    <div className="congestion-form-heading"><h3>Параметры дороги и времени</h3><p>Выбор района заполняет исходный профиль. Параметры можно изменить.</p></div>
    {modelFeatureNames.map(name => {
      const feature = metadata.features.find(item => item.name === name)!;
      const update = (value: string) => onChange({ ...draft, [name]: value });
      let control;
      if (name === 'is_main_road') {
        control = <select name={name} value={draft[name]} required onChange={event => update(event.target.value)}><option value="">Выберите тип</option><option value="1">Главная дорога</option><option value="0">Другая дорога</option></select>;
      } else if (name === 'district' || feature.kind === 'category' && (feature.options?.length ?? 0) > 0) {
        const options = name === 'district' ? metadata.districts.map(district => district.name) : feature.options ?? [];
        control = <select name={name} value={draft[name]} required onChange={event => update(event.target.value)}><option value="">Выберите значение</option>{options.map(option => <option key={option} value={option}>{option}</option>)}</select>;
      } else {
        control = <input name={name} type={feature.kind === 'integer' ? 'number' : 'text'} value={draft[name]} required
          min={feature.minimum ?? undefined} max={feature.maximum ?? undefined} step={feature.kind === 'integer' ? 1 : undefined}
          inputMode={feature.kind === 'integer' ? 'numeric' : undefined} list={name === 'season' ? 'model-season-suggestions' : undefined}
          aria-describedby={name === 'season' ? 'model-season-help' : name === 'population' ? 'model-population-help' : undefined}
          onChange={event => update(event.target.value)} />;
      }
      return <label className="control-field" key={name}>{feature.label}{control}
        {name === 'season' && <small id="model-season-help">Категории обучающего набора: «Лето» и «Не лето».</small>}
        {name === 'population' && <small id="model-population-help">Численность населения района в выбранном сценарии расчёта.</small>}
      </label>;
    })}
    <datalist id="model-season-suggestions">{metadata.season_suggestions.map(season => <option key={season} value={season} />)}</datalist>
    <button className="model-submit" type="submit" disabled={predicting || metadata.status !== 'ready'}>{predicting ? 'Вычисление…' : 'Рассчитать загруженность'}</button>
  </form>;
}

export function HourlyProfileChart({ result }: { result: ModelPredictionResponse }) {
  const values = result.hourly_profile.map(point => point.value);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(10, ...values);
  const y = (value: number) => (maximum - value) / (maximum - minimum) * 100;
  const x = (hour: number) => hour / 23 * 100;
  const selected = result.hourly_profile.find(point => point.hour === result.features.hour);
  const ticks = [minimum, (minimum + maximum) / 2, maximum].reverse();
  const outside = minimum < 0 || maximum > 10;
  return <figure className="hourly-profile">
    <figcaption><h3>Профиль по часам</h3><p>Оценки для 24 часов: меняется только час. Остальные введённые параметры сохраняются.</p><span>{result.features.district} · {result.features.day_of_week} · {result.features.season}</span></figcaption>
    <div className="model-profile-chart" role="img" aria-label={`Почасовая оценка загруженности для выбранного профиля дороги. Шкала от ${formatPrediction(minimum)} до ${formatPrediction(maximum)} баллов. Численные значения доступны в таблице.`}>
      <div className="model-profile-axis" aria-hidden="true">{ticks.map((tick, index) => <span key={index}>{formatPrediction(tick)}</span>)}</div>
      <div className="model-profile-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {ticks.map((tick, index) => <line key={index} x1="0" x2="100" y1={y(tick)} y2={y(tick)} className="model-profile-grid" />)}
          <polyline points={result.hourly_profile.map(point => `${x(point.hour)},${y(point.value)}`).join(' ')} fill="none" stroke="#2c638e" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          {selected && <line x1={x(selected.hour)} x2={x(selected.hour)} y1="0" y2="100" className="model-profile-selected" />}
        </svg>
        {selected && <span className="model-profile-point" style={{ left: `${x(selected.hour)}%`, top: `${y(selected.value)}%` }} aria-hidden="true" />}
        <div className="model-profile-hours" aria-hidden="true">{[0, 6, 12, 18, 23].map(hour => <span key={hour} style={{ left: `${x(hour)}%` }}>{formatHour(hour)}</span>)}</div>
      </div>
    </div>
    <p className="model-chart-note">Ожидаемый диапазон — 0–10 баллов.{outside && ' Значения вне него сохранены; шкала графика расширена.'}</p>
    <details className="model-hour-table"><summary>Значения за все 24 часа</summary><div className="table-scroll"><table><caption>Почасовой результат CatBoost · балл</caption><thead><tr><th scope="col">Час</th><th scope="col">Оценка</th></tr></thead><tbody>{result.hourly_profile.map(point => <tr key={point.hour} className={point.hour === result.features.hour ? 'selected-row' : undefined}><th scope="row">{formatHour(point.hour)}</th><td title={String(point.value)}>{formatPrediction(point.value)}</td></tr>)}</tbody></table></div></details>
  </figure>;
}

export function CongestionWorkspace() {
  const model = useCongestionModel();
  const { metadata, result, loading, predicting, error } = model;
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [formError, setFormError] = useState('');
  const [visibility, setVisibility] = useState<LayerVisibility>(emptyVisibility);
  useEffect(() => { if (metadata) { setDraft(initialModelDraft(metadata)); setFormError(''); } }, [metadata]);

  const catalog = useMemo<MapCatalog | null>(() => metadata ? {
    data_version: metadata.geography.geography_version,
    geography: { ...metadata.geography, boundaries: { ...metadata.geography.boundaries, features: metadata.geography.boundaries.features.filter(feature => feature.geometry.type.includes('Polygon')) }, reference_points: { type: 'FeatureCollection', features: [] } },
  } : null, [metadata]);
  const selectedId = metadata?.districts.find(district => district.name === draft?.district)?.feature_id ?? '';
  function updateDraft(next: ModelDraft) {
    if (next.district !== draft?.district) {
      const profile = districtProfiles[next.district as keyof typeof districtProfiles];
      if (profile) next = { ...next, lanes_total: String(profile.lanes_total), population: String(profile.population), is_main_road: String(profile.is_main_road) };
    }
    model.clearPrediction(); setFormError(''); setDraft(next);
  }
  useEffect(() => {
    if (!draft || !metadata || !draft.district) return;
    try { model.predict(featuresFromDraft(draft, metadata)); } catch { /* Incomplete input remains editable. */ }
  }, [draft, metadata]);
  function submit() {
    if (!draft || !metadata) return;
    try { const features = featuresFromDraft(draft, metadata); setFormError(''); model.predict(features); }
    catch (failure) { model.clearPrediction(); setFormError((failure as Error).message); }
  }
  const isStatic = model.mode === 'demo';
  const unavailable = metadata?.status === 'unavailable';

  return <div className="city-workspace congestion-workspace">
    <a className="skip-link" href="#model-main">Перейти к модели</a>
    <header className="page-header page-width"><div className="project-label"><Route size={18} aria-hidden="true" /><span>Новосибирск · CatBoost</span></div><h1>Модель загруженности дорог</h1></header>
    <main id="model-main" className="page-width model-main" tabIndex={-1}>
      <p className="model-intro">Оценка загруженности для одного профиля дороги по семи введённым признакам. Результат выражен в баллах с ожидаемым диапазоном 0–10.</p>
      {isStatic && <p className="model-intro">CatBoost рассчитывает индекс в браузере после изменения параметров.</p>}
      <div className="request-state" role="status" aria-live="polite">{loading ? 'Загрузка описания модели…' : predicting ? 'Вычисление оценки и почасового профиля…' : result ? 'Результат модели загружен для выбранных параметров.' : metadata?.status === 'ready' ? 'Модель готова. Заполните параметры и запустите расчёт.' : unavailable ? 'Модель недоступна.' : ''}</div>
      {(error || formError) && <div className="error-box" role="alert"><AlertCircle size={20} aria-hidden="true" /><div><strong>Расчёт не выполнен</strong><p>{formError || error}</p>{!metadata && model.canReload && <button type="button" onClick={model.reload}>Повторить загрузку</button>}</div></div>}
      {unavailable && <section className="model-status-panel" aria-labelledby="unavailable-model-heading"><h2 id="unavailable-model-heading">Сервис модели не готов</h2><p>{metadata.unavailable_reason || 'Обученный файл модели недоступен. Повторите загрузку позднее.'}</p><button type="button" onClick={model.reload}>Проверить доступность</button></section>}
      {metadata && draft && <>
        <section className="model-input-section" aria-labelledby="model-input-heading">
          <div className="section-heading"><div><h2 id="model-input-heading">Исходные параметры</h2><p>Выберите район на карте или в списке. Его контур обозначает расположение введённого профиля.</p></div><button className="model-reload" type="button" onClick={model.reload} disabled={loading || predicting}><RefreshCw size={15} aria-hidden="true" />Обновить модель</button></div>
          <div className="map-layout model-map-layout">
            <div className="map-primary"><ForecastMap metadata={catalog} forecast={null} selectedId={selectedId} affectedIds={noAffectedObjects} onSelect={id => {
              const district = metadata.districts.find(item => item.feature_id === id);
              if (district) updateDraft({ ...draft, district: district.name });
            }} changeMode="absolute" scale={emptyScale} visibility={visibility} loadLayer={model.loadGeographyLayer} /></div>
            <aside className="model-map-details" aria-label="Параметры модели"><CongestionForm metadata={metadata} draft={draft} onChange={updateDraft} onSubmit={submit} predicting={predicting} /></aside>
          </div>
          <div className="model-map-footnote"><p><i className="legend-selected" aria-hidden="true" />Выбранный район. Оценка относится к введённому профилю дороги; среднее по району не вычисляется.</p><fieldset className="model-layers"><legend>Слои карты</legend>{[{ id: 'districts', name: 'Границы' }, ...(metadata.geography.layers ?? []).map(layer => ({ id: layer.id, name: layer.name }))].map(layer => <label key={layer.id}><input type="checkbox" checked={visibility[layer.id] !== false} onChange={event => setVisibility(current => ({ ...current, [layer.id]: event.target.checked }))} />{layer.name}</label>)}</fieldset></div>
        </section>

        <section className="model-results" aria-labelledby="model-result-heading" aria-busy={predicting}>
          <div className="section-heading"><div><h2 id="model-result-heading">Оценка модели</h2><p>{result ? 'Результат для введённого профиля дороги и выбранного часа.' : 'Результат появится после расчёта.'}</p></div></div>
          {result ? <div className="model-result-grid"><article className="model-prediction-card"><h3>{result.target.name}</h3><strong title={String(result.prediction.value)}>{formatPrediction(result.prediction.value)}<small> {result.prediction.unit}</small></strong><p className="model-result-scope">{result.features.district}<br />{result.features.hour}:00 · {result.features.day_of_week} · {result.features.season}</p><dl><div><dt>Дорога</dt><dd>{result.features.is_main_road ? 'Главная' : 'Другая'}</dd></div><div><dt>Полос</dt><dd>{result.features.lanes_total}</dd></div><div><dt>Население</dt><dd>{new Intl.NumberFormat('ru-RU').format(result.features.population)}</dd></div></dl>{result.prediction.out_of_expected_range && <p className="model-warning">Результат вне ожидаемого диапазона 0–10 и показан без ограничения.</p>}{result.warnings.length > 0 && <ul className="model-warning-list">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</article><HourlyProfileChart result={result} /></div> : <div className="section-placeholder">{predicting ? 'Вычисление CatBoost…' : 'Укажите все семь признаков и нажмите «Рассчитать загруженность».'}</div>}
        </section>
      </>}


    </main>
  </div>;
}
