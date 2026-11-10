import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import metadataSchema from '../../../contracts/schemas/model-metadata-response.json';
import predictionSchema from '../../../contracts/schemas/model-prediction-response.json';
import type { components } from '../../../contracts/api.generated';
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
    if (config.mode !== 'api') throw new ModelDataError('Запуск CatBoost доступен в режиме API. Статическая демонстрация не выполняет модель.');
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
    const response = await fetcher(`${env.BASE_URL || '/'}demo/model/${path}`, { signal });
    if (!response.ok) throw new ModelDataError('Не удалось загрузить сохранённые результаты модели. Повторите запрос.');
    return response.json();
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
        const records = await staticJson('predictions.json', signal);
        if (!Array.isArray(records)) throw new ModelDataError('Некорректные результаты модели.');
        const saved = records.find(row => validateModelPrediction(row) && modelFeatureNames.filter(name => name !== 'hour').every(name => row.features[name] === features[name]));
        if (!saved || !validateModelPrediction(saved)) throw new ModelDataError('Для этой комбинации нет сохранённого расчёта. Используйте профиль обучающего набора или подключите API.');
        const point = saved.hourly_profile.find(point => point.hour === features.hour);
        if (!point) throw new ModelDataError('Нет расчёта выбранного часа.');
        result = { ...saved, features, prediction: { value: point.value, unit: 'балл', out_of_expected_range: point.value < 0 || point.value > 10 } };
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
      return result;
    },
  };
}
