import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type ExpressionSpecification, type GeoJSONSource, type Map as LibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { LocateFixed, Minus, Plus } from 'lucide-react';
import type { ForecastMetadata, ForecastResponse, GeographyLayer } from '../data/forecast-client';
import { dataBounds, geographyFeatures, labelPosition, renderCollection, type ChangeMode, type ChangeScale } from '../forecast/map-model';

export type LayerVisibility = Record<string, boolean>;
type Props = {
  metadata: ForecastMetadata | null; forecast: ForecastResponse | null;
  selectedId: string; affectedIds: string[]; onSelect: (id: string) => void;
  changeMode: ChangeMode; scale: ChangeScale; visibility: LayerVisibility;
  loadLayer?: (layer: GeographyLayer, signal?: AbortSignal) => Promise<FeatureCollection>;
};
const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const polygon: ExpressionSpecification = ['==', ['geometry-type'], 'Polygon'];
const line: ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
const point: ExpressionSpecification = ['==', ['geometry-type'], 'Point'];
const analyticalLayers = ['forecast-zones', 'forecast-sections', 'forecast-points', 'forecast-undefined'];
const districtLayers = ['district-outline'];
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function fitData(instance: LibreMap, metadata: ForecastMetadata | null) {
  const bounds = dataBounds(metadata);
  if (bounds) instance.fitBounds(bounds, { padding: 35, duration: 0, maxZoom: 13 });
}

function addContext(instance: LibreMap, descriptor: GeographyLayer) {
  const source = `geography-${descriptor.id}`;
  if (!instance.getSource(source)) instance.addSource(source, { type: 'geojson', data: empty });
  const layers: string[] = [];
  const before = 'district-fill';
  if (descriptor.geometry_types.some(type => type.includes('Polygon'))) {
    const water = descriptor.id === 'water';
    const id = `${source}-fill`;
    if (!instance.getLayer(id)) instance.addLayer({ id, type: 'fill', source, filter: polygon, minzoom: descriptor.id === 'buildings' ? 12 : 0,
      paint: { 'fill-color': water ? '#b9d9e8' : '#cbd2d7', 'fill-opacity': water ? 1 : .8 } }, before);
    layers.push(id);
    if (!water) {
      const outline = `${source}-outline`;
      if (!instance.getLayer(outline)) instance.addLayer({ id: outline, type: 'line', source, filter: polygon, minzoom: 13,
        paint: { 'line-color': '#afb9c1', 'line-width': .5 } }, before);
      layers.push(outline);
    }
  }
  if (descriptor.geometry_types.some(type => type.includes('LineString'))) {
    const water = descriptor.id === 'water';
    if (!water) {
      const halo = `${source}-halo`;
      if (!instance.getLayer(halo)) instance.addLayer({ id: halo, type: 'line', source, filter: line,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c5cbd0', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.3, 13, 3, 16, 8] } }, before);
      layers.push(halo);
    }
    const id = `${source}-line`;
    if (!instance.getLayer(id)) instance.addLayer({ id, type: 'line', source, filter: line,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': water ? '#a4cbdc' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 9, water ? 1 : .6, 13, water ? 3 : 2, 16, water ? 7 : 6] } }, before);
    layers.push(id);
  }
  if (descriptor.geometry_types.includes('Point')) {
    const id = `${source}-point`;
    if (!instance.getLayer(id)) instance.addLayer({ id, type: 'circle', source, filter: point,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 14, 3.5], 'circle-color': '#fff', 'circle-stroke-color': '#587b93', 'circle-stroke-width': 1 } }, before);
    layers.push(id);
  }
  return { source, layers };
}

export function ForecastMap({ metadata, forecast, selectedId, affectedIds, onSelect, changeMode, scale, visibility, loadLayer }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const labels = useRef(new Map<string, maplibregl.Marker>());
  const context = useRef(new Map<string, string[]>());
  const callback = useRef(onSelect); callback.current = onSelect;
  const selected = useRef(selectedId); selected.current = selectedId;
  const catalog = useRef(metadata); catalog.current = metadata;
  const visible = useRef(visibility); visible.current = visibility;
  const fitted = useRef('');
  const loadVisible = useRef<() => void>(() => {});
  const arrangeLabels = useRef<() => void>(() => {});
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [failedLayers, setFailedLayers] = useState<string[]>([]);
  const [pendingLayers, setPendingLayers] = useState<string[]>([]);
  const [layerError, setLayerError] = useState(false);
  const [updating, setUpdating] = useState(false);
  const rendered = useMemo(() => renderCollection(forecast, changeMode, scale), [forecast, changeMode, scale]);

  useEffect(() => {
    if (!container.current) return;
    let instance: LibreMap;
    try {
      instance = new maplibregl.Map({ container: container.current, minZoom: 2, maxZoom: 19, attributionControl: false,
        fadeDuration: 0, cooperativeGestures: true,
        locale: { 'Map.Title': 'Карта Новосибирска', 'Marker.Title': 'Объект данных',
          'AttributionControl.ToggleAttribution': 'Источники карты',
          'CooperativeGesturesHandler.WindowsHelpText': 'Для изменения масштаба удерживайте Ctrl',
          'CooperativeGesturesHandler.MacHelpText': 'Для изменения масштаба удерживайте ⌘',
          'CooperativeGesturesHandler.MobileHelpText': 'Для перемещения карты используйте два пальца' },
        style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f3f5f4' } }] },
      });
    } catch { setUnavailable(true); return; }
    map.current = instance;
    const arrange = () => {
      const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
      const markers = [...labels.current.entries()].sort(([a], [b]) => Number(b === selected.current) - Number(a === selected.current));
      for (const [id, marker] of markers) {
        const element = marker.getElement();
        const candidate = element.classList.contains('has-metric') || id === selected.current;
        const position = instance.project(marker.getLngLat());
        const width = Math.min(140, (element.textContent?.length ?? 0) * 6 + 12);
        const rect = { left: position.x - width / 2, right: position.x + width / 2, top: position.y - 11, bottom: position.y + 11 };
        const collision = occupied.some(other => rect.left < other.right + 3 && rect.right > other.left - 3 && rect.top < other.bottom + 3 && rect.bottom > other.top - 3);
        const show = candidate && (id === selected.current || !collision);
        element.style.display = show ? '' : 'none';
        if (show) occupied.push(rect);
      }
    };
    arrangeLabels.current = arrange; instance.on('moveend', arrange);
    instance.on('load', () => {
      instance.addSource('catalog', { type: 'geojson', data: empty, tolerance: 0 });
      instance.addSource('forecast', { type: 'geojson', data: empty, tolerance: 0 });
      instance.addLayer({ id: 'district-fill', type: 'fill', source: 'catalog', filter: polygon, paint: { 'fill-color': '#e9eff2', 'fill-opacity': .06 } });
      instance.addLayer({ id: 'forecast-zones', type: 'fill', source: 'forecast', filter: polygon, paint: { 'fill-color': ['get', 'render_color'], 'fill-opacity': .28 } });
      instance.addLayer({ id: 'forecast-zone-outline', type: 'line', source: 'forecast', filter: polygon, paint: { 'line-color': '#839aa9', 'line-width': .7 } });
      instance.addLayer({ id: 'district-outline', type: 'line', source: 'catalog', filter: polygon, paint: { 'line-color': '#657e90', 'line-width': 1, 'line-dasharray': [4, 2] } });
      instance.addLayer({ id: 'forecast-sections', type: 'line', source: 'forecast', filter: line, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'render_color'], 'line-width': 5 } });
      instance.addLayer({ id: 'forecast-undefined', type: 'line', source: 'forecast', filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'render_change'], null]], paint: { 'line-color': '#7c868d', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
      instance.addLayer({ id: 'stops', type: 'circle', source: 'catalog', filter: point, paint: { 'circle-radius': 4, 'circle-color': '#fff', 'circle-stroke-color': '#47687e', 'circle-stroke-width': 1.5 } });
      instance.addLayer({ id: 'forecast-points', type: 'circle', source: 'forecast', filter: point, paint: { 'circle-radius': 5, 'circle-color': ['get', 'render_color'], 'circle-stroke-color': '#3e566b', 'circle-stroke-width': 1 } });
      instance.addLayer({ id: 'affected', type: 'line', source: 'catalog', filter: ['==', ['get', 'feature_id'], ''], paint: { 'line-color': '#b54245', 'line-width': 3, 'line-dasharray': [3, 2] } });
      instance.addLayer({ id: 'selected-shape', type: 'line', source: 'catalog', filter: ['==', ['get', 'feature_id'], ''], paint: { 'line-color': '#205c84', 'line-width': 3 } });
      instance.addLayer({ id: 'selected-point', type: 'circle', source: 'catalog', filter: ['==', ['get', 'feature_id'], ''], paint: { 'circle-radius': 8, 'circle-color': '#205c84', 'circle-opacity': .25, 'circle-stroke-color': '#205c84', 'circle-stroke-width': 2 } });
      instance.addLayer({ id: 'section-hit', type: 'line', source: 'forecast', filter: line, paint: { 'line-width': 16, 'line-opacity': 0 } });
      instance.addLayer({ id: 'stop-hit', type: 'circle', source: 'catalog', filter: point, paint: { 'circle-radius': 12, 'circle-opacity': 0 } });
      const hits = ['stop-hit', 'section-hit', 'forecast-zones', 'district-fill'];
      instance.on('click', event => {
        if (event.originalEvent.target instanceof Element && event.originalEvent.target.closest('button, a, summary')) return;
        const hit = instance.queryRenderedFeatures(event.point, { layers: hits })[0];
        if (typeof hit?.properties?.feature_id === 'string') callback.current(hit.properties.feature_id);
      });
      instance.on('mousemove', event => { instance.getCanvas().style.cursor = instance.queryRenderedFeatures(event.point, { layers: hits }).length ? 'pointer' : ''; });
      instance.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '<a href="#map-attribution">Источники и условия</a> | MapLibre' }), 'bottom-right');
      setReady(true);
    });
    instance.on('error', event => {
      const sourceId = (event as { sourceId?: string }).sourceId;
      if (sourceId?.startsWith('geography-')) setFailedLayers(current => [...new Set([...current, sourceId.replace('geography-', '')])]);
      else setLayerError(true);
    });
    const observer = new ResizeObserver(() => { instance.resize(); arrange(); }); observer.observe(container.current);
    return () => { observer.disconnect(); labels.current.forEach(marker => marker.remove()); labels.current.clear(); context.current.clear(); instance.remove(); map.current = null; };
  }, []);

  useLayoutEffect(() => {
    if (!ready || !map.current?.getSource('catalog')) return;
    const instance = map.current;
    const features = geographyFeatures(metadata);
    (instance.getSource('catalog') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    const ids = new Set(features.map(feature => feature.id));
    labels.current.forEach((marker, id) => { if (!ids.has(id)) { marker.remove(); labels.current.delete(id); } });
    for (const feature of features) {
      const existing = labels.current.get(feature.id);
      if (existing) {
        existing.setLngLat(labelPosition(feature.geometry));
        existing.getElement().textContent = feature.properties.name.replace(/ район$/, '');
        continue;
      }
      const element = document.createElement('button'); element.type = 'button'; element.className = 'area-label district-marker'; element.dataset.featureId = feature.id;
      element.textContent = feature.properties.name.replace(/ район$/, '');
      element.addEventListener('click', event => { event.stopPropagation(); callback.current(feature.id); });
      labels.current.set(feature.id, new maplibregl.Marker({ element, anchor: 'center' }).setLngLat(labelPosition(feature.geometry)).addTo(instance));
    }
    if (metadata && fitted.current !== metadata.geography.geography_version) { fitData(instance, metadata); fitted.current = metadata.geography.geography_version ?? metadata.data_version; }
    arrangeLabels.current();
  }, [ready, metadata]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const instance = map.current; const controller = new AbortController();
    const active = new Set(metadata?.geography.layers?.map(layer => layer.id) ?? []);
    context.current.forEach((ids, id) => {
      if (active.has(id)) return;
      ids.forEach(layer => { if (instance.getLayer(layer)) instance.removeLayer(layer); });
      if (instance.getSource(`geography-${id}`)) instance.removeSource(`geography-${id}`);
      context.current.delete(id);
    });
    setFailedLayers([]); setPendingLayers([]);
    if (!metadata || !loadLayer) return;
    const order: Record<string, number> = { water: 0, buildings: 1, roads: 2, stops: 3 };
    const layers = [...(metadata.geography.layers ?? [])].sort((a, b) => (order[a.id] ?? 2) - (order[b.id] ?? 2));
    for (const descriptor of layers) {
      const { source, layers: ids } = addContext(instance, descriptor); context.current.set(descriptor.id, ids);
      for (const id of ids) instance.setLayoutProperty(id, 'visibility', visible.current[descriptor.id] === false ? 'none' : 'visible');
      (instance.getSource(source) as GeoJSONSource).setData(empty);
    }
    const requested = new Set<string>();
    const start = () => {
      for (const descriptor of layers) {
        if (requested.has(descriptor.id) || visible.current[descriptor.id] === false || (descriptor.id === 'buildings' && instance.getZoom() < 12)) continue;
        requested.add(descriptor.id); setPendingLayers(current => [...current, descriptor.name]);
        loadLayer(descriptor, controller.signal).then(async data => {
          if (!controller.signal.aborted) await (instance.getSource(`geography-${descriptor.id}`) as GeoJSONSource | undefined)?.setData(data, true);
        }).catch(() => { if (!controller.signal.aborted) setFailedLayers(current => [...current, descriptor.name]); })
          .finally(() => { if (!controller.signal.aborted) setPendingLayers(current => current.filter(name => name !== descriptor.name)); });
      }
    };
    loadVisible.current = start; instance.on('zoomend', start); start();
    const attribution = metadata.geography.sources?.map(source => escapeHtml(source.attribution)).join(' · ');
    (instance.getSource('catalog') as GeoJSONSource).attribution = attribution || '';
    // Update attribution through the source's supported data event.
    (instance.getSource('catalog') as GeoJSONSource).setData({ type: 'FeatureCollection', features: geographyFeatures(metadata) });
    return () => { controller.abort(); instance.off('zoomend', start); loadVisible.current = () => {}; };
  }, [ready, metadata, loadLayer]);

  useLayoutEffect(() => {
    if (!ready || !map.current?.getSource('forecast')) return;
    const instance = map.current; let cancelled = false; setUpdating(true); setLayerError(false);
    (instance.getSource('forecast') as GeoJSONSource).setData(rendered, true).then(() => {
      if (cancelled) return;
      instance.once('render', () => { if (!cancelled) setUpdating(false); }); instance.triggerRepaint();
    }).catch(() => { if (!cancelled) { setUpdating(false); setLayerError(true); } });
    const values = new Map(forecast?.geojson.features.map(feature => [feature.id, feature]));
    const catalogFeatures = geographyFeatures(metadata);
    labels.current.forEach((marker, id) => {
      const element = marker.getElement(); const feature = values.get(id);
      element.classList.toggle('has-metric', Boolean(feature));
      element.setAttribute('aria-label', `Выбрать объект: ${catalogFeatures.find(item => item.id === id)?.properties.name}`);
    });
    arrangeLabels.current();
    return () => { cancelled = true; };
  }, [ready, rendered, metadata, forecast]);

  useLayoutEffect(() => {
    if (!ready || !map.current) return;
    const instance = map.current;
    labels.current.forEach((marker, id) => marker.getElement().setAttribute('aria-pressed', String(id === selectedId)));
    if (!instance.getLayer('selected-shape')) return;
    instance.setFilter('selected-shape', ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'feature_id'], selectedId]]);
    instance.setFilter('selected-point', ['all', point, ['==', ['get', 'feature_id'], selectedId]]);
    instance.setFilter('affected', ['all', ['!=', ['geometry-type'], 'Point'], ['in', ['get', 'feature_id'], ['literal', affectedIds]]]);
    arrangeLabels.current();
  }, [ready, selectedId, affectedIds, metadata]);

  useLayoutEffect(() => {
    if (!ready || !map.current) return;
    const instance = map.current;
    const set = (ids: string[], enabled: boolean) => ids.forEach(id => { if (instance.getLayer(id)) instance.setLayoutProperty(id, 'visibility', enabled ? 'visible' : 'none'); });
    set(analyticalLayers, visibility.forecast !== false); set(['section-hit'], visibility.forecast !== false);
    set(['forecast-zone-outline'], visibility.forecast !== false && visibility.districts !== false);
    set(districtLayers, visibility.districts !== false); set(['stops', 'stop-hit'], visibility.stops !== false);
    context.current.forEach((ids, id) => set(ids, visibility[id] !== false));
    loadVisible.current();
  }, [ready, visibility, metadata]);

  return <div className="forecast-map-frame">
    <div className="forecast-map" ref={container} role="region" aria-label="Карта Новосибирска: границы десяти районов, здания, дороги и реки. Выбор района также доступен в списке." />
    {unavailable && <div className="map-unavailable" role="status">Карта недоступна: требуется WebGL. Показатели, графики и таблица доступны ниже.</div>}
    {pendingLayers.length > 0 && <div className="map-status" role="status">Загрузка геоданных…</div>}
    {failedLayers.length > 0 && <div className="map-message" role="status">Не загружены слои: {failedLayers.join(', ')}. Границы районов и аналитические данные доступны независимо.</div>}
    {layerError && <div className="map-message" role="status">Ошибка отображения аналитического слоя. Значения доступны в карточке и таблице.</div>}
    {updating && !unavailable && <div className="map-updating" role="status">Обновление показателя…</div>}
    <div className="map-navigation"><button aria-label="Приблизить карту" disabled={!ready} onClick={() => map.current?.zoomIn({ duration: 0 })}><Plus size={17} /></button><button aria-label="Отдалить карту" disabled={!ready} onClick={() => map.current?.zoomOut({ duration: 0 })}><Minus size={17} /></button><button aria-label="Показать весь Новосибирск" disabled={!ready} onClick={() => map.current && fitData(map.current, metadata)}><LocateFixed size={17} /></button></div>
  </div>;
}
