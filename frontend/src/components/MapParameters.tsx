import { RefreshCw } from 'lucide-react';
import type { ForecastMetadata, ForecastSelection } from '../data/forecast-client';
import { geographyFeatures, geometryLabel } from '../forecast/map-model';
import type { LayerVisibility } from './ForecastMap';

type Props = {
  metadata: ForecastMetadata | null; selection: ForecastSelection | null;
  onChange: (selection: ForecastSelection) => void; selectedId: string; onSelect: (id: string) => void;
  visibility: LayerVisibility; onLayerChange: (id: string, value: boolean) => void;
  loading: boolean; canReload: boolean; onReload: () => void;
};

export function MapParameters({ metadata, selection, onChange, selectedId, onSelect, visibility, onLayerChange, loading, canReload, onReload }: Props) {
  const catalog = geographyFeatures(metadata);
  const districts = catalog.filter(feature => feature.geometry.type.includes('Polygon'));
  const other = catalog.filter(feature => !feature.geometry.type.includes('Polygon'));
  const selectedDistrict = districts.some(feature => feature.id === selectedId) ? selectedId : '';
  const layerNames = [{ id: 'districts', name: 'Границы районов' }, { id: 'forecast', name: 'Изменение показателя' },
    ...(metadata?.geography.layers ?? []).map(layer => ({ id: layer.id, name: layer.name }))];
  return <div className="map-parameters">
    <div className="parameters-heading"><h3>Параметры карты</h3><button aria-label="Обновить данные" title="Обновить данные" disabled={loading || !canReload} onClick={onReload}><RefreshCw size={15} /></button></div>
    <label className="control-field">Показатель<select disabled={!metadata} value={selection?.metric ?? ''} onChange={event => selection && onChange({ ...selection, metric: event.target.value })}>{!metadata && <option value="">Нет данных</option>}{metadata?.metrics.map(metric => <option key={metric.id} value={metric.id}>{metric.name}</option>)}</select></label>
    <label className="control-field">Сценарий<select disabled={!metadata} value={selection?.scenario ?? ''} onChange={event => selection && onChange({ ...selection, scenario: event.target.value })}>{!metadata && <option value="">Нет данных</option>}{metadata?.scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>)}</select></label>
    <label className="control-field district-select">Район<select disabled={!metadata} value={selectedDistrict} onChange={event => onSelect(event.target.value)}><option value="">Все районы</option>{districts.map(feature => <option key={feature.id} value={feature.id}>{feature.properties.name}</option>)}</select></label>
    {other.length > 0 && <label className="control-field other-object-select">Участок / станция<select disabled={!metadata} value={selectedDistrict ? '' : selectedId} onChange={event => onSelect(event.target.value)}><option value="">Не выбран</option>{other.map(feature => <option key={feature.id} value={feature.id}>{geometryLabel(feature.geometry.type)} · {feature.properties.name}</option>)}</select></label>}
    <fieldset className="layers-panel"><legend>Слои</legend>{layerNames.map(layer => <label key={layer.id} title={layer.id === 'buildings' ? 'Здания отображаются при приближении карты' : undefined}><input type="checkbox" checked={visibility[layer.id] !== false} onChange={event => onLayerChange(layer.id, event.target.checked)} />{layer.name}</label>)}</fieldset>
  </div>;
}
