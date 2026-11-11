import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import metadataSchema from '../../../contracts/schemas/model-metadata-response.json';
import predictionSchema from '../../../contracts/schemas/model-prediction-response.json';
import districtProfiles from '../../../contracts/model-profiles.json';
import type { components } from '../../../contracts/api.generated';
import { predictBrowserModel, type BrowserModel } from '../model/browser-inference';
import { readConfiguration, type Environment } from './config';
import { createForecastClient } from './forecast-client';

type MetadataContract = components['schemas']['ModelMetadata'];
type PredictionContract = components['schemas']['ModelPredictionResponse'];
export type ModelMetadata = MetadataContract & { target: NonNullable<MetadataContract['target']> };
export type ModelPredictionResponse = PredictionContract & {
  target: NonNullable<PredictionContract['target']>;
  hourly_profile: NonNullable<PredictionContract['hourly_profile']>;
};
export type ModelFeatures = ModelPredictionResponse['features'];
export const modelFeatureNames = ['hour', 'district', 'is_main_road', 'day_of_week', 'season', 'lanes_total', 'population'] as const;

const ajv = new Ajv2020({ strict: false, strictNumbers: true });
addFormats(ajv);
const metadataContract = ajv.compile<MetadataContract>(metadataSchema);
const predictionContract = ajv.compile<PredictionContract>(predictionSchema);
export function validateModelMetadata(value: unknown): value is ModelMetadata {
  return metadataContract(value) && value.schema_version === '1.0' && value.target?.id === 'congestion_index_0_10'
    && value.target.unit === 'балл' && value.target.expected_min === 0 && value.target.expected_max === 10;
}
export function validateModelPrediction(value: unknown): value is ModelPredictionResponse {
  return predictionContract(value) && value.schema_version === '1.0' && value.target?.id === 'congestion_index_0_10'
    && value.target.unit === 'балл' && value.prediction.unit === 'балл' && Array.isArray(value.hourly_profile);
}

export class ModelDataError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ModelDataError';
  }
}

export function createModelClient(env: Environment, fetcher: typeof fetch = fetch) {
  const config = readConfiguration(env);
  const geography = createForecastClient(env, fetcher);
  async function read<T extends object>(path: string, validate: (value: unknown) => value is T, signal?: AbortSignal, body?: object): Promise<T> {
    const timeout = AbortSignal.timeout(15000);
    let response: Response;
    try {
      response = await fetcher(`${config.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ModelDataError('Сервис модели недоступен. Проверьте подключение и повторите запрос.');
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new ModelDataError(payload?.error?.message || `Запрос модели завершился с ошибкой HTTP ${response.status}.`, response.status);
    }
    const value: unknown = await response.json();
    if (!validate(value)) throw new ModelDataError('Ответ модели не соответствует контракту 1.0.');
    return value;
  }

  async function staticJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(15000);
    try {
      const response = await fetcher(`${env.BASE_URL || '/'}demo/model/${path}`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new ModelDataError(`HTTP ${response.status}`, response.status);
      return await response.json();
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ModelDataError('Не удалось загрузить файл модели. Повторите запрос.');
    }
  }

  // The model is shared by every parameter choice. Cancelled computations do
  // not cancel the shared download, and a failed download can be retried.
  let browserModel: { sha: string; request: Promise<BrowserModel> } | undefined;
  function loadBrowserModel(sha: string) {
    if (browserModel?.sha === sha) return browserModel.request;
    const request = staticJson(`browser-model.json?v=${encodeURIComponent(sha)}`).then(value => {
      if (!value || typeof value !== 'object' || !('data' in value) || !('categorical_hashes' in value)) {
        throw new ModelDataError('Некорректный файл модели.');
      }
      if (!('model_sha256' in value) || value.model_sha256 !== sha) throw new ModelDataError('Версия файла модели не соответствует метаданным. Повторите запрос.');
      return value as BrowserModel;
    }).catch(error => {
      if (browserModel?.request === request) browserModel = undefined;
      throw error;
    });
    browserModel = { sha, request };
    return request;
  }
  return {
    mode: config.mode,
    loadGeographyLayer: geography.getGeographyLayer,
    async getMetadata(signal?: AbortSignal): Promise<ModelMetadata> {
      const value = config.mode === 'demo' ? await staticJson('metadata.json', signal) : await read('/api/v1/model/metadata', validateModelMetadata, signal);
      if (!validateModelMetadata(value)) throw new ModelDataError('Некорректное описание модели.');
      const metadata = value;
      const names = metadata.features.map(feature => feature.name);
      if (names.length !== modelFeatureNames.length || modelFeatureNames.some(name => !names.includes(name)) || metadata.has_year_feature !== false) {
        throw new ModelDataError('Описание признаков модели не соответствует контракту 1.0.');
      }
      return metadata;
    },
    async predict(features: ModelFeatures, metadata: ModelMetadata, signal?: AbortSignal): Promise<ModelPredictionResponse> {
      if (metadata.status !== 'ready') throw new ModelDataError(metadata.unavailable_reason || 'Модель временно недоступна.', 503);
      let result: ModelPredictionResponse;
      if (config.mode === 'demo') {
        const artifact = await loadBrowserModel(metadata.model_sha256);
        signal?.throwIfAborted();
        result = predictBrowserModel(artifact, features, metadata);
        if (!validateModelPrediction(result)) throw new ModelDataError('Результат модели не соответствует контракту 1.0.');
      } else result = await read('/api/v1/model/predict', validateModelPrediction, signal, { features, include_hourly_profile: true });
      if (result.model_version !== metadata.model_version || result.target.id !== metadata.target.id || result.target.unit !== metadata.target.unit
        || result.feature_id !== metadata.districts.find(district => district.name === features.district)?.feature_id
        || modelFeatureNames.some(name => result.features[name] !== features[name])) {
        throw new ModelDataError('Ответ модели не соответствует выбранным параметрам или версии модели.');
      }
      const profile = result.hourly_profile;
      if (profile.length !== 24 || profile.some((point, index) => point.hour !== index)
        || Math.abs(profile[features.hour].value - result.prediction.value) > 1e-9 * Math.max(1, Math.abs(result.prediction.value))) {
        throw new ModelDataError('Почасовой профиль модели неполон или не соответствует выбранному часу.');
      }
      const training = districtProfiles[features.district];
      if (training && (training.is_main_road !== features.is_main_road || training.lanes_total !== features.lanes_total || training.population !== features.population)) {
        return { ...result, warnings: ['Тип дороги, полосность или население отличаются от профиля этого района в обучающем наборе. Точность для этих параметров не проверена.', ...result.warnings] };
      }
      return result;
    },
  };
}
