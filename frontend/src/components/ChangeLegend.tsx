import type { ChangeScale } from '../forecast/map-model';
import { formatValue } from '../forecast/presentation';

export function ChangeLegend({ scale, unit }: { scale: ChangeScale; unit: string }) {
  return <div className="change-legend" aria-label="Цвета изменений: одинаковые границы шкал для всех лет, без оценки положительного или отрицательного эффекта">
    <div><strong>{scale.positiveLabel}</strong><span><i style={{ background: `linear-gradient(to right,${scale.positiveLight},${scale.positiveDark})` }} />0 … +{formatValue(scale.positiveMax)} {unit}</span></div>
    <div><strong>{scale.negativeLabel}</strong><span><i style={{ background: `linear-gradient(to right,${scale.negativeDark},${scale.negativeLight})` }} />−{formatValue(scale.negativeMax)} … 0 {unit}</span></div>
    {scale.transportLoad && <div><strong>Рост без усиления перегрузки</strong><span><i style={{ background: 'linear-gradient(to right,#f1e8cf,#9c8041)' }} />0 … +{formatValue(scale.positiveMax)} {unit}</span></div>}
    <p><b className="neutral-swatch" style={{ background: scale.zeroColor }} /> 0 — без изменения <b className="missing-swatch" /> Нет данных об изменении</p>
  </div>;
}
