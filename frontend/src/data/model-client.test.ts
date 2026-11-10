import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createModelClient, validateModelMetadata, validateModelPrediction, type ModelFeatures, type ModelMetadata, type ModelPredictionResponse } from './model-client';

const geography = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/forecast/geography.json', import.meta.url), 'utf8'));
const target: ModelMetadata['target'] = { id: 'congestion_index_0_10', name: 'Индекс загруженности', unit: 'балл', expected_min: 0, expected_max: 10, description: 'Оценка загруженности для заданного дорожного профиля.' };
const features: ModelFeatures = { hour: 12, district: 'Советский', is_main_road: 1, day_of_week: 'Понедельник', season: 'Не лето', lanes_total: 4, population: 120000 };
const metadata: ModelMetadata = {
  schema_version: '1.0', status: 'ready', model_version: 'test-cbm-sha256', model_sha256: 'a'.repeat(64), target,
  features: [
    { name: 'hour', label: 'Час', kind: 'integer', required: true, minimum: 0, maximum: 23, options: [] },
    { name: 'district', label: 'Район', kind: 'category', required: true, minimum: null, maximum: null, options: ['Советский'] },
    { name: 'is_main_road', label: 'Магистральная дорога', kind: 'integer', required: true, minimum: 0, maximum: 1, options: [] },
    { name: 'day_of_week', label: 'День недели', kind: 'category', required: true, minimum: null, maximum: null, options: ['Понедельник'] },
    { name: 'season', label: 'Сезон', kind: 'category', required: true, minimum: null, maximum: null, options: [] },
    { name: 'lanes_total', label: 'Полос всего', kind: 'integer', required: true, minimum: 1, maximum: null, options: [] },
    { name: 'population', label: 'Население', kind: 'integer', required: true, minimum: 0, maximum: null, options: [] },
  ],
  districts: [{ name: 'Советский', feature_id: 'district-sovetsky' }], season_suggestions: ['Лето', 'Не лето'],
  has_year_feature: false, disclaimer: 'Модель оценивает один профиль, не среднее по району.', geography, unavailable_reason: null,
};
const prediction: ModelPredictionResponse = {
  schema_version: '1.0', model_version: metadata.model_version, target, features, feature_id: 'district-sovetsky',
  prediction: { value: 10.123456789, unit: 'балл', out_of_expected_range: true },
  hourly_profile: Array.from({ length: 24 }, (_, hour) => ({ hour, value: hour === 12 ? 10.123456789 : hour / 3 })), warnings: ['Выход за ожидаемый диапазон.'],
};
const apiEnv = { BASE_URL: '/LogisticsCase1/', VITE_DATA_MODE: 'api', VITE_API_BASE_URL: 'https://api.example.test/planner/' };
const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));

describe('CatBoost model transport', () => {
  it('validates the dedicated model contracts without manufacturing year or scenario fields', () => {
    expect(validateModelMetadata(metadata)).toBe(true);
    expect(validateModelPrediction(prediction)).toBe(true);
    expect(validateModelPrediction({ ...prediction, prediction: { ...prediction.prediction, value: Infinity } })).toBe(false);
    expect(validateModelMetadata({ ...metadata, has_year_feature: true })).toBe(false);
  });

  it('requests model metadata from the configured API prefix', async () => {
    const fetcher = vi.fn<typeof fetch>(() => json(metadata));
    expect(await createModelClient(apiEnv, fetcher).getMetadata()).toEqual(metadata);
    expect(fetcher.mock.calls[0][0]).toBe('https://api.example.test/planner/api/v1/model/metadata');
  });

  it('sends exactly the seven raw features and retains an unclipped prediction and all 24 hours', async () => {
    const fetcher = vi.fn<typeof fetch>(() => json(prediction));
    const result = await createModelClient(apiEnv, fetcher).predict(features, metadata);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.example.test/planner/api/v1/model/predict');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ features, include_hourly_profile: true });
    expect(result.prediction.value).toBe(10.123456789);
    expect(result.prediction.out_of_expected_range).toBe(true);
    expect(result.hourly_profile.map(point => point.hour)).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
  });

  it('loads schema-validated saved predictions in Pages mode without API calls', async () => {
    const storedMetadata = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/model/metadata.json', import.meta.url), 'utf8'));
    const records = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/model/predictions.json', import.meta.url), 'utf8'));
    const fetcher = vi.fn<typeof fetch>(url => json(String(url).endsWith('metadata.json') ? storedMetadata : records));
    const client = createModelClient({ BASE_URL: '/LogisticsCase1/', VITE_DATA_MODE: 'demo' }, fetcher);
    const catalog = await client.getMetadata();
    for (const record of records) expect(validateModelPrediction(record)).toBe(true);
    const input = { ...records[0].features, hour: 12 };
    const result = await client.predict(input, catalog);
    expect(result.prediction.value).toBe(records[0].hourly_profile[12].value);
    expect(fetcher.mock.calls.every(([url]) => String(url).startsWith('/LogisticsCase1/demo/model/'))).toBe(true);
    await expect(client.predict({ ...input, population: 1 }, catalog)).rejects.toThrow('нет сохранённого');
  });

  it('surfaces API failure without substituting static data', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Model artifact is unavailable' } }), { status: 503 }));
    await expect(createModelClient(apiEnv, fetcher).predict(features, metadata)).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).not.toContain('/demo/');
  });

  it('preserves abort signals for superseded requests', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => json(metadata));
    await createModelClient(apiEnv, fetcher).getMetadata(controller.signal);
    const requestSignal = fetcher.mock.calls[0][1]?.signal;
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([
    ['another model', (result: ModelPredictionResponse) => { result.model_version = 'other-cbm'; }],
    ['another district geometry', (result: ModelPredictionResponse) => { result.feature_id = 'district-leninsky'; }],
    ['different input features', (result: ModelPredictionResponse) => { result.features.season = 'Лето'; }],
    ['missing hours', (result: ModelPredictionResponse) => { result.hourly_profile.pop(); }],
    ['duplicate hours', (result: ModelPredictionResponse) => { result.hourly_profile[23].hour = 0; }],
    ['a different selected-hour result', (result: ModelPredictionResponse) => { result.hourly_profile[12].value = 3; }],
  ] as const)('rejects a response with %s instead of rendering mismatched results', async (_label, mutate) => {
    const invalid = structuredClone(prediction);
    mutate(invalid);
    const fetcher = vi.fn<typeof fetch>(() => json(invalid));
    await expect(createModelClient(apiEnv, fetcher).predict(features, metadata)).rejects.toThrow();
  });
});
