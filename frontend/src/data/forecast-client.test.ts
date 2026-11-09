import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createForecastClient, validateForecast, validateForecastMetadata, validateGeography } from './forecast-client';

const fixture = (file: string) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/forecast/${file}`, import.meta.url), 'utf8'));
const metadata = fixture('metadata.json');
const selection = { year: 2030, metric: 'population', scenario: 'baseline' };
const demoEnv = { BASE_URL: '/LogisticsCase1/', VITE_DATA_MODE: 'demo' };
const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));

describe('forecast transport contract', () => {
  it('validates metadata and every published combination with the exported schemas', () => {
    expect(validateForecastMetadata(metadata)).toBe(true);
    for (const { id: scenario } of metadata.scenarios) {
      for (const { id: metric } of metadata.metrics) {
        for (const year of metadata.available_years) {
          expect(validateForecast(fixture(`${scenario}/${metric}/${year}.json`))).toBe(true);
        }
      }
    }
  });

  it('uses the Pages project base for static metadata and forecast', async () => {
    const forecast = fixture('baseline/population/2030.json');
    const fetcher = vi.fn().mockImplementationOnce(() => json(metadata)).mockImplementationOnce(() => json(forecast));
    const result = await createForecastClient(demoEnv, fetcher).getForecast(selection);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/LogisticsCase1/demo/forecast/metadata.json', '/LogisticsCase1/demo/forecast/baseline/population/2030.json',
    ]);
    expect(result).toEqual(forecast);
  });

  it('returns the identical payload in API and static demo mode', async () => {
    const forecast = fixture('baseline/population/2030.json');
    const fetcher = () => vi.fn().mockImplementationOnce(() => json(metadata)).mockImplementationOnce(() => json(forecast));
    const apiFetch = fetcher();
    const api = createForecastClient({ ...demoEnv, VITE_DATA_MODE: 'api', VITE_API_BASE_URL: 'https://api.example.test/planner/' }, apiFetch);
    const demo = createForecastClient(demoEnv, fetcher());
    expect(await api.getForecast(selection)).toEqual(await demo.getForecast(selection));
    expect(apiFetch.mock.calls.map(call => call[0])).toEqual([
      'https://api.example.test/planner/api/v1/metadata',
      'https://api.example.test/planner/api/v1/forecast?year=2030&metric=population&scenario=baseline',
    ]);
  });

  it('preserves zero, missing values, null deltas and provider-authored intervals unchanged', async () => {
    const forecast = fixture('baseline/population/2030.json');
    Object.assign(forecast.geojson.features[0].properties, { baseline_value: 0, delta_percent: null });
    Object.assign(forecast.geojson.features[1].properties, { baseline_value: null, delta_absolute: null, delta_percent: null, quality_status: 'missing_baseline' });
    const fetcher = vi.fn().mockImplementationOnce(() => json(metadata)).mockImplementationOnce(() => json(forecast));
    const result = await createForecastClient(demoEnv, fetcher).getForecast(selection);
    const zero = result.geojson.features[0].properties;
    const missing = result.geojson.features[1].properties;
    expect(zero.baseline_value).toBe(0);
    expect(zero.delta_percent).toBeNull();
    expect(missing.baseline_value).toBeNull();
    expect(missing.delta_absolute).toBeNull();
    expect(result.critical_intervals).toEqual(forecast.critical_intervals);
  });

  it.each([{ ...selection, year: 2031 }, { ...selection, metric: 'unknown' }, { ...selection, scenario: 'unknown' }])('rejects unsupported selections before requesting a static forecast', async query => {
    const fetcher = vi.fn().mockImplementation(() => json(metadata));
    await expect(createForecastClient(demoEnv, fetcher).getForecast(query)).rejects.toMatchObject({ status: 422 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces provider errors without falling back to demo files', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => json(metadata)).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'service_unavailable', message: 'Provider is unavailable' } }), { status: 503 }));
    const client = createForecastClient({ ...demoEnv, VITE_DATA_MODE: 'api', VITE_API_BASE_URL: 'https://api.example.test' }, fetcher);
    await expect(client.getForecast(selection)).rejects.toMatchObject({ status: 503, message: 'Provider is unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid response or mismatched forecast identity', async () => {
    const forecast = fixture('baseline/population/2030.json'); forecast.forecast_year = 2029;
    const fetcher = vi.fn().mockImplementationOnce(() => json(metadata)).mockImplementationOnce(() => json(forecast));
    await expect(createForecastClient(demoEnv, fetcher).getForecast(selection)).rejects.toThrow('identity/provenance');
    expect(validateForecast({ base_year: 2024 })).toBe(false);
    forecast.geojson.features[0].properties.forecast_value = Infinity;
    expect(validateForecast(forecast)).toBe(false);
  });

  it('rejects static metadata disguised as non-demo data', async () => {
    const fetcher = vi.fn().mockImplementation(() => json({ ...metadata, is_demo: false }));
    await expect(createForecastClient(demoEnv, fetcher).getMetadata()).rejects.toThrow('is_demo=true');
  });

  it('loads all metadata years in one series with no extra metadata calls and rejects mixed baselines', async () => {
    const fetcher = vi.fn().mockImplementation((url: string) => {
      const year = url.match(/\/(\d+)\.json$/)?.[1];
      return json(fixture(`baseline/population/${year}.json`));
    });
    const client = createForecastClient(demoEnv, fetcher);
    const all = await client.getForecastSeries(metadata, 'population', 'baseline');
    expect(all.map(response => response.forecast_year)).toEqual(metadata.available_years);
    expect(fetcher).toHaveBeenCalledTimes(metadata.available_years.length);
    const broken = vi.fn().mockImplementation((url: string) => {
      const year = url.match(/\/(\d+)\.json$/)?.[1];
      const response = fixture(`baseline/population/${year}.json`);
      if (Number(year) === metadata.available_years.at(-1)) response.geojson.features[0].properties.baseline_value = 1;
      return json(response);
    });
    await expect(createForecastClient(demoEnv, broken).getForecastSeries(metadata, 'population', 'baseline')).rejects.toThrow('identity/provenance');
  });
});


describe('real geography transport', () => {
  const geography = fixture('geography.json');
  it('loads the same geography from API and static mode and keeps real geography distinct from demo statistics', async () => {
    expect(validateGeography(geography)).toBe(true);
    expect(geography.is_synthetic).toBe(false);
    const staticFetch = vi.fn().mockImplementation(() => json(geography));
    const apiFetch = vi.fn().mockImplementation(() => json(geography));
    const demo = await createForecastClient(demoEnv, staticFetch).getGeography();
    const api = await createForecastClient({ ...demoEnv, VITE_DATA_MODE: 'api', VITE_API_BASE_URL: 'https://api.example.test' }, apiFetch).getGeography();
    expect(demo).toEqual(api);
    expect(staticFetch.mock.calls[0][0]).toBe('/LogisticsCase1/demo/forecast/geography.json');
    expect(apiFetch.mock.calls[0][0]).toBe('https://api.example.test/api/v1/geography');
  });
  it('uses metadata layer paths or the configured API host with identical data', async () => {
    const layer = geography.layers.find((item: { id: string }) => item.id === 'stops');
    const data = JSON.parse(readFileSync(new URL('../../../contracts/geography/stops.geojson', import.meta.url), 'utf8'));
    const staticFetch = vi.fn().mockImplementation(() => json(data));
    const apiFetch = vi.fn().mockImplementation(() => json(data));
    const demo = await createForecastClient(demoEnv, staticFetch).getGeographyLayer(layer);
    const api = await createForecastClient({ ...demoEnv, VITE_DATA_MODE: 'api', VITE_API_BASE_URL: 'https://api.example.test/prefix' }, apiFetch).getGeographyLayer(layer);
    expect(demo).toEqual(api);
    expect(staticFetch.mock.calls[0][0]).toBe('/LogisticsCase1/geography/stops.geojson');
    expect(apiFetch.mock.calls[0][0]).toBe('https://api.example.test/prefix/api/v1/geography/layers/stops');
  });
  it('rejects layer traversal, wrong geometry and unavailable layers without synthetic fallback', async () => {
    const layer = geography.layers[0];
    const fetcher = vi.fn(() => json({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [83,55] }, properties: {} }] }));
    const client = createForecastClient(demoEnv, fetcher);
    await expect(client.getGeographyLayer({ ...layer, asset_path: '../secret.geojson' })).rejects.toThrow('contract');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.getGeographyLayer(layer)).rejects.toThrow('geometry contract');
    const failed = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(createForecastClient(demoEnv, failed).getGeographyLayer(layer)).rejects.toThrow('unavailable');
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
