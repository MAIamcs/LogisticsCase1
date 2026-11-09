// Transport only. Critical intervals and analytical decisions belong to the provider.
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import metadataSchema from '../../../contracts/schemas/forecast-metadata-response.json';
import forecastSchema from '../../../contracts/schemas/forecast-response.json';
import geographySchema from '../../../contracts/schemas/geography-response.json';
import geographyLayerSchema from '../../../contracts/schemas/geography-layer-response.json';
import type { FeatureCollection } from 'geojson';
import type { components, paths } from '../../../contracts/api.generated';
import { readConfiguration, type Environment } from './config';

export type ForecastMetadata = components['schemas']['ForecastMetadataResponse'];
export type ForecastResponse = components['schemas']['ForecastResponse'];
export type Geography = components['schemas']['Geography'];
export type GeographyLayer = NonNullable<Geography['layers']>[number];
export type ForecastSelection = NonNullable<paths['/api/v1/forecast']['get']['parameters']['query']>;

const ajv = new Ajv2020({ strict: false, strictNumbers: true });
addFormats(ajv);
export const validateForecastMetadata = ajv.compile<ForecastMetadata>(metadataSchema);
export const validateForecast = ajv.compile<ForecastResponse>(forecastSchema);
export const validateGeography = ajv.compile<Geography>(geographySchema);
const validateGeographyLayer = ajv.compile<FeatureCollection>(geographyLayerSchema);

export class ForecastDataError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ForecastDataError';
  }
}

export function createForecastClient(env: Environment, fetcher: typeof fetch = fetch) {
  const config = readConfiguration(env);
  async function read<T extends object>(url: string, validate: (value: unknown) => value is T, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(15000);
    let response: Response;
    try {
      response = await fetcher(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ForecastDataError(config.mode === 'api' ? 'Forecast API is unavailable.' : 'Static forecast demo data is unavailable.');
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new ForecastDataError(body?.error?.message || `Forecast request failed (HTTP ${response.status}).`, response.status);
    }
    const value: unknown = await response.json();
    if (!validate(value)) throw new ForecastDataError('Response does not match contract version 1.2.');
    if (config.mode === 'demo' && 'is_demo' in value && !value.is_demo) throw new ForecastDataError('Static forecast data must be marked is_demo=true.');
    return value;
  }

  const getMetadata = (signal?: AbortSignal) => read(
    config.mode === 'demo' ? `${config.assetBase}demo/forecast/metadata.json` : `${config.baseUrl}/api/v1/metadata`,
    validateForecastMetadata, signal,
  );

  return {
    mode: config.mode,
    getMetadata,
    getGeography(signal?: AbortSignal) {
      return read(config.mode === 'demo' ? `${config.assetBase}demo/forecast/geography.json` : `${config.baseUrl}/api/v1/geography`, validateGeography, signal);
    },
    async getGeographyLayer(layer: GeographyLayer, signal?: AbortSignal): Promise<FeatureCollection> {
      // Paths come from validated metadata; API mode always uses its configured
      // host. Failure never substitutes a synthetic background or forecast.
      if (!/^[a-zA-Z0-9_/-]+\.geojson$/.test(layer.asset_path) || layer.asset_path.split('/').includes('..')) throw new ForecastDataError('Invalid geography asset contract.');
      const url = config.mode === 'demo' ? `${config.assetBase}${layer.asset_path}` : `${config.baseUrl}/api/v1/geography/layers/${encodeURIComponent(layer.id)}`;
      const result = await read(url, validateGeographyLayer, signal);
      if (result.features.some(feature => !feature.geometry || !(layer.geometry_types as readonly string[]).includes(feature.geometry.type))) throw new ForecastDataError('Geography layer does not match its geometry contract.');
      return result;
    },
    async getForecast(selection: ForecastSelection, signal?: AbortSignal, catalog?: ForecastMetadata): Promise<ForecastResponse> {
      const metadata = catalog ?? await getMetadata(signal);
      for (const [field, allowed] of [
        ['year', metadata.available_years], ['metric', metadata.metrics.map(item => item.id)],
        ['scenario', metadata.scenarios.map(item => item.id)],
      ] as const) {
        if (!(allowed as readonly (string | number)[]).includes(selection[field])) {
          throw new ForecastDataError(`Unknown ${field} '${selection[field]}'. Available values: ${allowed.join(', ')}.`, 422);
        }
      }
      const { year, metric, scenario } = selection;
      const query = new URLSearchParams({ year: String(year), metric, scenario });
      const url = config.mode === 'demo'
        ? `${config.assetBase}demo/forecast/${encodeURIComponent(scenario)}/${encodeURIComponent(metric)}/${year}.json`
        : `${config.baseUrl}/api/v1/forecast?${query}`;
      const result = await read(url, validateForecast, signal);
      if (result.base_year !== metadata.base_year || result.forecast_year !== year || result.metric !== metric || result.scenario !== scenario || result.data_version !== metadata.data_version || result.is_demo !== metadata.is_demo) {
        throw new ForecastDataError('Forecast identity/provenance does not match metadata and selection.');
      }
      return result;
    },
    async getForecastSeries(metadata: ForecastMetadata, metric: string, scenario: string, signal?: AbortSignal): Promise<ForecastResponse[]> {
      const series = await Promise.all(metadata.available_years.map(year => this.getForecast({ year, metric, scenario }, signal, metadata)));
      const signature = (response: ForecastResponse) => JSON.stringify({
        model: response.model_version,
        features: response.geojson.features.map(feature => [feature.id, [feature.geometry.type, feature.geometry.coordinates], feature.properties.name, feature.properties.baseline_value, feature.properties.unit]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      });
      if (series.some(response => signature(response) !== signature(series[0]))) {
        throw new ForecastDataError('Forecast identity/provenance changed within the year series.');
      }
      return series;
    },
  };
}
