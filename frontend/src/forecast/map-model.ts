import type { FeatureCollection, Geometry, Position } from 'geojson';
import type { ForecastMetadata, ForecastResponse } from '../data/forecast-client';

export type ChangeMode = 'absolute' | 'percent';
export type MetricDefinition = ForecastMetadata['metrics'][number];
export type MapFeature = ForecastResponse['geojson']['features'][number];
export type ChangeScale = {
  transportLoad: boolean;
  positiveMax: number; negativeMax: number; positiveLabel: string; negativeLabel: string;
  positiveLight: string; positiveDark: string; negativeLight: string; negativeDark: string;
};

export function changeValue(feature: MapFeature, mode: ChangeMode): number | null {
  return mode === 'absolute' ? feature.properties.delta_absolute : feature.properties.delta_percent;
}

export function changeScale(series: ForecastResponse[], definition: MetricDefinition | undefined, mode: ChangeMode): ChangeScale {
  const values = series.flatMap(response => response.geojson.features.flatMap(feature => {
    const value = changeValue(feature, mode); return value === null ? [] : [value];
  }));
  const population = definition?.semantic_type === 'population';
  const load = definition?.semantic_type === 'transport_load';
  return {
    transportLoad: load,
    positiveMax: Math.max(0, ...values), negativeMax: Math.max(0, ...values.map(value => -value)),
    positiveLabel: population ? 'Прирост населения' : load ? 'Рост загрузки при усилении перегрузки' : 'Увеличение показателя',
    negativeLabel: population ? 'Убыль населения' : load ? 'Снижение загрузки' : 'Уменьшение показателя',
    positiveLight: population ? '#d6eadd' : load ? '#f5d9d7' : '#d7e7f2',
    positiveDark: population ? '#287b52' : load ? '#b8413d' : '#316e9b',
    negativeLight: population ? '#e5e2f0' : '#d7e8f3',
    negativeDark: population ? '#6c5b9b' : '#306c9b',
  };
}

function interpolate(light: string, dark: string, ratio: number): string {
  const a = light.slice(1).match(/../g)!.map(value => parseInt(value, 16));
  const b = dark.slice(1).match(/../g)!.map(value => parseInt(value, 16));
  return '#' + a.map((value, index) => Math.round(value + (b[index] - value) * Math.min(1, Math.max(0, ratio))).toString(16).padStart(2, '0')).join('');
}

export function changeColor(value: number | null, scale: ChangeScale, feature?: MapFeature): string {
  if (value === null) return '#dfe4e8';
  if (value === 0) return '#f1f3f5';
  if (value > 0 && scale.transportLoad && feature) {
    const { baseline_value: baseline, forecast_value: forecast } = feature.properties;
    // A load ratio above 100% is an excess over capacity, NOT a replacement
    // share or an intervention decision. Intervals remain provider-authored.
    if (baseline != null && forecast != null && Math.max(forecast - 100, 0) <= Math.max(baseline - 100, 0)) {
      return interpolate('#f1e8cf', '#9c8041', value / scale.positiveMax);
    }
  }
  return value > 0 ? interpolate(scale.positiveLight, scale.positiveDark, value / scale.positiveMax)
    : interpolate(scale.negativeLight, scale.negativeDark, -value / scale.negativeMax);
}

export function renderCollection(forecast: ForecastResponse | null, mode: ChangeMode, scale: ChangeScale): FeatureCollection {
  return {
    type: 'FeatureCollection', features: forecast?.geojson.features.map(feature => {
      const value = changeValue(feature, mode);
      return { ...feature, properties: { ...feature.properties, render_change: value, render_color: changeColor(value, scale, feature) } };
    }) ?? [],
  };
}

export function geometryPositions(geometry: Geometry): Position[] {
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(geometryPositions);
  function walk(value: unknown): Position[] {
    if (!Array.isArray(value)) return [];
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') return [value];
    return value.flatMap(walk);
  }
  return walk(geometry.coordinates);
}

export function geographyFeatures(metadata: ForecastMetadata | null) {
  return metadata ? [...metadata.geography.boundaries.features, ...(metadata.geography.reference_points?.features ?? [])] : [];
}

export function dataBounds(metadata: ForecastMetadata | null): [[number, number], [number, number]] | null {
  const positions = geographyFeatures(metadata).flatMap(feature => geometryPositions(feature.geometry));
  return positions.length ? [[Math.min(...positions.map(p => p[0])), Math.min(...positions.map(p => p[1]))],
    [Math.max(...positions.map(p => p[0])), Math.max(...positions.map(p => p[1]))]] : null;
}

export function geometryLabel(type: string): string {
  return type.includes('Polygon') ? 'Район' : type.includes('LineString') ? 'Транспортный участок' : 'Остановка / станция';
}

function inRing(point: Position, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function inPolygon(point: Position, rings: Position[][]): boolean {
  return inRing(point, rings[0]) && !rings.slice(1).some(ring => inRing(point, ring));
}

/** Interior label point only; original district geometry is never simplified,
 * buffered or replaced by a rectangle for rendering/selection. */
export function labelPosition(geometry: Geometry): [number, number] {
  if (geometry.type === 'Point') return [geometry.coordinates[0], geometry.coordinates[1]];
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const candidates: { point: [number, number]; width: number }[] = [];
    for (const polygon of polygons) {
      const ys = polygon[0].map(point => point[1]);
      const south = Math.min(...ys), north = Math.max(...ys);
      for (let step = 1; step < 10; step++) {
        const y = south + (north - south) * step / 10;
        const xs = polygon.flatMap(ring => ring.slice(1).flatMap((b, i) => {
          const a = ring[i];
          return (a[1] > y) !== (b[1] > y) ? [a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])] : [];
        })).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) {
          const point: [number, number] = [(xs[i - 1] + xs[i]) / 2, y];
          if (inPolygon(point, polygon)) candidates.push({ point, width: xs[i] - xs[i - 1] });
        }
      }
    }
    candidates.sort((a, b) => b.width - a.width);
    if (candidates[0]) return candidates[0].point;
  }
  const positions = geometryPositions(geometry);
  const point = positions[Math.floor(positions.length / 2)] ?? [0, 0];
  return [point[0], point[1]];
}
