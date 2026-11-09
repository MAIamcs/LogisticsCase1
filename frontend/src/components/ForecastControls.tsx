import type { ForecastMetadata, ForecastSelection } from '../data/forecast-client';
import { intervalKey, severityLabels, yearPosition, type CriticalInterval } from '../forecast/presentation';
import './forecast-timeline.css';

type Props = {
  metadata: ForecastMetadata | null; selection: ForecastSelection | null;
  onChange: (selection: ForecastSelection) => void; intervals: CriticalInterval[];
  selectedInterval: string | null; onIntervalSelect: (key: string) => void;
  loading: boolean; hasError: boolean; showDemo: boolean; canReload: boolean; onReload: () => void;
};

export function ForecastControls(props: Props) {
  const { metadata, selection, onChange, intervals, selectedInterval, onIntervalSelect } = props;
  const years = metadata?.available_years ?? [];
  const yearIndex = selection ? years.indexOf(selection.year) : 0;
  const intervalHelp = props.loading ? 'Загрузка интервалов…' : props.hasError
    ? 'Критические интервалы не загружены. Повторите запрос.'
    : intervals.length ? `Красные отметки — критические интервалы поставщика: ${intervals.map(interval => `${interval.start_year}–${interval.end_year}`).join('; ')}. Выберите отметку для просмотра причины и действия.`
      : 'Критических интервалов в данных поставщика нет.';

  return <div className="controls-sticky forecast-timeline" id="forecast-controls">
    <div className="page-width timeline-inner">
      <div className="timeline-current"><span>Год</span><output htmlFor="forecast-year-slider" aria-label="Выбранный год">{selection?.year ?? '—'}</output></div>
      <div className="timeline-control">
        <label className="sr-only" htmlFor="forecast-year-slider">Год прогноза</label>
        <div className="timeline-track">
          <span className="timeline-track-line" aria-hidden="true" />
          {intervals.map((interval, index) => {
            const key = intervalKey(interval, index);
            const left = yearPosition(interval.start_year, years);
            const right = yearPosition(interval.end_year, years);
            return <span key={key} data-interval-key={key} className="timeline-interval" style={{ left: `calc(9px + (100% - 18px) * ${left})`, width: `calc((100% - 18px) * ${Math.max(right - left, .005)})` }} aria-hidden="true" />;
          })}
          <input id="forecast-year-slider" type="range" min={0} max={Math.max(0, years.length - 1)} step={1}
            value={Math.max(0, yearIndex)} disabled={years.length < 2}
            aria-valuetext={selection ? `${selection.year} год` : 'Нет доступных лет'} aria-describedby="year-scale-help"
            onChange={event => selection && onChange({ ...selection, year: years[Number(event.target.value)] })} />
          {intervals.map((interval, index) => {
            const key = intervalKey(interval, index);
            const midpoint = (yearPosition(interval.start_year, years) + yearPosition(interval.end_year, years)) / 2;
            return <button key={key} className={`timeline-critical-marker ${selectedInterval === key ? 'selected' : ''}`}
              style={{ left: `calc(9px + (100% - 18px) * ${midpoint})` }} onClick={() => onIntervalSelect(key)}
              aria-pressed={selectedInterval === key}
              aria-label={`Критический интервал ${interval.start_year}–${interval.end_year}. ${severityLabels[interval.severity]}. Показать территории, причину и рекомендуемое действие.`}
              title={`${interval.start_year}–${interval.end_year} · ${severityLabels[interval.severity]}`}><span aria-hidden="true">!</span></button>;
          })}
        </div>
        <div className="timeline-years" aria-label="Доступные годы">{years.map((year, index) => <button key={year}
          className={year === selection?.year ? 'active' : ''}
          style={{ left: `calc(9px + (100% - 18px) * ${years.length > 1 ? index / (years.length - 1) : 0})` }}
          onClick={() => selection && onChange({ ...selection, year })} aria-pressed={year === selection?.year} aria-label={`Выбрать ${year} год`}>{year}</button>)}</div>
        {years.length === 0 && <p className="timeline-state">{props.loading ? 'Загрузка…' : 'Нет доступных лет'}</p>}
        <p id="year-scale-help" className="sr-only">{intervalHelp}</p>
      </div>
    </div>
  </div>;
}
