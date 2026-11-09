import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ForecastMetadata, ForecastResponse } from '../data/forecast-client';
import { changeColor, changeScale, changeValue, dataBounds, inPolygon, labelPosition, renderCollection } from './map-model';

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/forecast/${path}`, import.meta.url), 'utf8'));
const metadata: ForecastMetadata = read('metadata.json');
const series = (metric: string): ForecastResponse[] => metadata.available_years.map(year => read(`baseline/${metric}/${year}.json`));

describe('real geography and map semantics', () => {
  it('preserves all ten original district contours in the analytical layer in every year', () => {
    const source = JSON.parse(readFileSync(new URL('../../../contracts/geography/districts.geojson', import.meta.url), 'utf8'));
    const originals = new Map(source.features.map((feature: { id: string; geometry: unknown }) => [feature.id, feature.geometry]));
    for (const response of series('population')) {
      const scale = changeScale(series('population'), metadata.metrics[0], 'absolute');
      const rendered = renderCollection(response, 'absolute', scale);
      expect(rendered.features).toHaveLength(10);
      for (const feature of rendered.features) expect(feature.geometry).toEqual(originals.get(feature.id));
    }
    expect(metadata.geography.is_synthetic).toBe(false);
    expect(metadata.available_years).toEqual([2026, 2027, 2028, 2029, 2030]);
  });

  it('keeps comparable domains and separate population growth/decline ramps across years', () => {
    const all = series('population');
    const scale = changeScale(all, metadata.metrics.find(metric => metric.id === 'population'), 'absolute');
    expect(scale.positiveMax).toBeGreaterThan(0);
    expect(scale.negativeMax).toBeGreaterThan(0);
    expect(scale.positiveLabel).toBe('Прирост населения'); expect(scale.negativeLabel).toBe('Убыль населения');
    expect(changeColor(100, scale)).not.toBe(changeColor(-100, scale));
    const snapshot = structuredClone(scale);
    for (const response of all) {
      const layer = renderCollection(response, 'absolute', scale);
      expect(layer.features[0].properties!.render_color).toBe(changeColor(response.geojson.features[0].properties.delta_absolute, snapshot));
      expect(scale).toEqual(snapshot);
    }
  });

  it('distinguishes increasing overload from increasing utilization below capacity and decreases', () => {
    const all = series('infrastructure_load');
    const scale = changeScale(all, metadata.metrics.find(metric => metric.id === 'infrastructure_load'), 'absolute');
    const response = all.at(-1)!;
    const decline = response.geojson.features.find(feature => feature.properties.delta_absolute! < 0)!;
    const overload = response.geojson.features.find(feature => feature.properties.forecast_value! > 100)!;
    const below = response.geojson.features.find(feature => feature.properties.delta_absolute! > 0 && feature.properties.forecast_value! < 100)!;
    expect(scale.positiveDark).toBe('#b8413d'); expect(scale.negativeDark).toBe('#306c9b');
    expect(changeColor(decline.properties.delta_absolute, scale)).not.toBe(changeColor(-decline.properties.delta_absolute!, scale));
    expect(changeColor(overload.properties.delta_absolute, scale, overload)).not.toBe(changeColor(below.properties.delta_absolute, scale, below));
    expect(changeColor(below.properties.delta_absolute, scale, below)).not.toBe(changeColor(below.properties.delta_absolute, scale));
    expect(response.aggregates.aggregation).toBe('mean');
    expect(response.geojson.features.every(feature => feature.geometry.type.includes('LineString'))).toBe(true);
  });

  it('keeps null percentages distinct from observed zero without dropping geometry', () => {
    const response = structuredClone(series('population')[1]);
    const feature = response.geojson.features[0];
    Object.assign(feature.properties, { baseline_value: 0, forecast_value: 10, delta_absolute: 10, delta_percent: null });
    const scale = changeScale([response], metadata.metrics[0], 'percent');
    expect(changeValue(feature, 'absolute')).toBe(10); expect(changeValue(feature, 'percent')).toBeNull();
    expect(changeColor(null, scale)).not.toBe(changeColor(0, scale));
    expect(renderCollection(response, 'percent', scale).features).toHaveLength(10);
  });

  it('fits actual coordinates including disconnected Kalininsky territory and optional stations', () => {
    const before = dataBounds(metadata)!;
    const catalog = structuredClone(metadata);
    catalog.geography.reference_points!.features!.push({ type: 'Feature', id: 'outlying-stop', geometry: { type: 'Point', coordinates: [84, 56] }, properties: { feature_id: 'outlying-stop', name: 'Тестовая станция' } });
    expect(dataBounds(catalog)).toEqual([[before[0][0], before[0][1]], [84, 56]]);
    expect(dataBounds(null)).toBeNull();
    expect(metadata.geography.boundaries.features.find(feature => feature.id === 'district-kalininsky')!.geometry.type).toBe('MultiPolygon');
  });

  it('places district labels inside the district rather than inside holes or a concave bounding box', () => {
    for (const feature of series('population')[0].geojson.features) {
      const label = labelPosition(feature.geometry);
      const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : [];
      expect(polygons.some(polygon => inPolygon(label, polygon))).toBe(true);
    }
    const concave = { type: 'Polygon' as const, coordinates: [[[0,0],[5,0],[5,1],[1,1],[1,5],[0,5],[0,0]]] };
    expect(inPolygon(labelPosition(concave), concave.coordinates)).toBe(true);
    const holed = { type: 'Polygon' as const, coordinates: [[[0,0],[6,0],[6,6],[0,6],[0,0]],[[2,2],[4,2],[4,4],[2,4],[2,2]]] };
    expect(inPolygon(labelPosition(holed), holed.coordinates)).toBe(true);
  });
});
