import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as LibreMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { LocateFixed, Minus, Plus } from 'lucide-react';
import type { Corridor } from '../data/client';

type Props = { corridors: Corridor[]; selectedId: string | null; showLinks: boolean; showPlaces: boolean; onSelect: (id: string) => void };
const places: [string, number, number, boolean][] = [
  ['Новосибирск', 82.948, 55.033, true], ['Обь', 82.692, 54.997, false],
  ['Академгородок', 83.106, 54.854, false], ['Бердск', 83.111, 54.762, false],
  ['Кольцово', 83.181, 54.937, false], ['Калининский район', 82.967, 55.105, false],
];

function fitNetwork(instance: LibreMap, corridors: Corridor[]) {
  if (!corridors.length) return;
  const bounds = new maplibregl.LngLatBounds();
  corridors.forEach(corridor => corridor.geometry.coordinates.forEach(position => bounds.extend(position)));
  instance.fitBounds(bounds, { padding: { top: 80, bottom: 75, left: 40, right: 65 }, maxZoom: 11, duration: 0 });
}

export function TransportMap({ corridors, selectedId, showLinks, showPlaces, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<LibreMap | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const corridorsRef = useRef(corridors);
  corridorsRef.current = corridors;
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState(false);
  const [contextError, setContextError] = useState(false);

  useEffect(() => {
    if (!container.current) return;
    let instance: LibreMap;
    try {
      instance = new maplibregl.Map({
        container: container.current, center: [82.96, 54.955], zoom: 9.6,
        minZoom: 7, maxZoom: 16, attributionControl: false,
        style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9ece5' } }] },
      });
    } catch {
      setMapError(true);
      return;
    }
    map.current = instance;
    const abort = new AbortController();
    instance.on('load', () => {
      instance.addSource('context', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      instance.addLayer({ id: 'parks', type: 'fill', source: 'context', filter: ['==', ['get', 'category'], 'park'], paint: { 'fill-color': '#d3ddc8', 'fill-opacity': .7 } });
      instance.addLayer({ id: 'water', type: 'fill', source: 'context', filter: ['==', ['get', 'category'], 'water'], paint: { 'fill-color': '#b6d2d2' } });
      instance.addLayer({ id: 'streets', type: 'line', source: 'context', filter: ['==', ['get', 'category'], 'street'], paint: { 'line-color': '#fff', 'line-width': 2, 'line-opacity': .8 } });
      instance.addLayer({ id: 'roads', type: 'line', source: 'context', filter: ['==', ['get', 'category'], 'road'], paint: { 'line-color': '#ffffff', 'line-width': 7 } });
      instance.addSource('corridors', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      instance.addLayer({ id: 'selection', type: 'line', source: 'corridors', filter: ['==', ['get', 'id'], ''], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#163e38', 'line-width': 13, 'line-opacity': .22 } });
      instance.addLayer({ id: 'corridor-lines', type: 'line', source: 'corridors', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
        'line-color': ['step', ['get', 'load_percent'], '#448f7b', 60, '#d9a34a', 80, '#ca725e'],
        'line-width': 4,
      } });
      instance.addLayer({ id: 'corridor-hit-area', type: 'line', source: 'corridors', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 20 } });
      instance.on('click', 'corridor-hit-area', event => {
        const id = event.features?.[0]?.properties?.id;
        if (typeof id === 'string') onSelectRef.current(id);
      });
      instance.on('mouseenter', 'corridor-hit-area', () => { instance.getCanvas().style.cursor = 'pointer'; });
      instance.on('mouseleave', 'corridor-hit-area', () => { instance.getCanvas().style.cursor = ''; });
      for (const [name, lng, lat, primary] of places) {
        const element = document.createElement('div');
        element.className = `place-label ${primary ? 'primary' : ''}`;
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', name);
        element.setAttribute('tabindex', '-1');
        const dot = document.createElement('span');
        dot.className = 'place-dot';
        element.append(dot, document.createTextNode(name));
        markers.current.push(new maplibregl.Marker({ element, anchor: 'left' }).setLngLat([lng, lat]).addTo(instance));
      }
      fetch(`${import.meta.env.BASE_URL}demo/context.geojson`, { signal: abort.signal })
        .then(response => { if (!response.ok) throw new Error('Context unavailable'); return response.json(); })
        .then((data: FeatureCollection) => { (instance.getSource('context') as GeoJSONSource | undefined)?.setData(data); })
        .catch(() => { if (!abort.signal.aborted) setContextError(true); });
      setReady(true);
    });
    instance.on('error', () => { setContextError(true); });
    const observer = new ResizeObserver(() => {
      instance.resize();
      fitNetwork(instance, corridorsRef.current);
    });
    observer.observe(container.current);
    return () => {
      abort.abort(); observer.disconnect(); markers.current.forEach(marker => marker.remove()); markers.current = [];
      instance.remove(); map.current = null; setReady(false);
    };
  }, []);

  useEffect(() => {
    if (!ready || !map.current) return;
    (map.current.getSource('corridors') as GeoJSONSource).setData({ type: 'FeatureCollection', features: corridors });
    fitNetwork(map.current, corridors);
  }, [ready, corridors]);

  useEffect(() => {
    if (!ready || !map.current) return;
    map.current.setFilter('selection', ['==', ['get', 'id'], selectedId || '']);
    for (const layer of ['selection', 'corridor-lines', 'corridor-hit-area']) {
      map.current.setLayoutProperty(layer, 'visibility', showLinks ? 'visible' : 'none');
    }
    markers.current.forEach(marker => { marker.getElement().style.display = showPlaces ? '' : 'none'; });
  }, [ready, selectedId, showLinks, showPlaces]);

  return <div className="map-shell">
    <div ref={container} className="map-canvas" role="region" aria-label="Схематичная карта транспортных связей. Выбор связей также доступен в списке." />
    {mapError && <div className="map-fallback" role="status">Карта недоступна: для MapLibre требуется WebGL. Все связи доступны в списке справа.</div>}
    {contextError && !mapError && <div className="map-warning" role="status">Схематичная подложка недоступна</div>}
    <div className="map-caption"><span className="live-dot" /> Новосибирская агломерация <span className="map-caption-note">Схема</span></div>
    <div className="map-controls">
      <button aria-label="Приблизить карту" onClick={() => map.current?.zoomIn()} disabled={mapError}><Plus size={18} /></button>
      <button aria-label="Отдалить карту" onClick={() => map.current?.zoomOut()} disabled={mapError}><Minus size={18} /></button>
      <button aria-label="Вернуть исходный вид карты" onClick={() => { if (map.current) fitNetwork(map.current, corridors); }} disabled={mapError}><LocateFixed size={18} /></button>
    </div>
    <div className="map-key"><strong>Загрузка связи</strong><span><i className="key-line green" /> &lt; 60%</span><span><i className="key-line amber" /> 60–79%</span><span><i className="key-line coral" /> ≥ 80%</span></div>
    <div className="map-attribution">Схематичная подложка · синтетическая геометрия · MapLibre</div>
  </div>;
}
