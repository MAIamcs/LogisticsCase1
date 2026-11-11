import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { predictBrowserScalar, predictBrowserModel, type BrowserModel } from './browser-inference';
import type { ModelFeatures, ModelMetadata } from '../data/model-client';
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const artifact: BrowserModel = read('../../../contracts/fixtures/model/browser-model.json');
const metadata: ModelMetadata = read('../../../contracts/fixtures/model/metadata.json');
const cases: { features: ModelFeatures; expected: number }[] = read('../../../backend/tests/fixtures/browser-inference-parity.json').rows;
const saved = read('../../../contracts/fixtures/model/predictions.json');

describe('CatBoost browser inference parity', () => {
  it('matches original CBM at numeric borders, unseen configurations, zero population and both flags', () => {
    for (const probe of cases) expect(predictBrowserScalar(artifact, probe.features), JSON.stringify(probe.features)).toBeCloseTo(probe.expected, 10);
  });
  it('matches all 3360 saved hourly model predictions', () => {
    for (const profile of saved) for (const point of profile.hourly_profile) {
      expect(predictBrowserScalar(artifact, { ...profile.features, hour: point.hour })).toBeCloseTo(point.value, 10);
    }
  });
  it('returns a full profile for arbitrary valid numeric inputs without clipping', () => {
    const result = predictBrowserModel(artifact, cases[0].features, metadata);
    expect(result.hourly_profile).toHaveLength(24);
    expect(result.prediction.value).toBeCloseTo(cases[0].expected, 10);
    expect(() => predictBrowserModel({ ...artifact, model_sha256: 'wrong' }, cases[0].features, metadata)).toThrow('Версия');
    expect(() => predictBrowserModel(artifact, { ...cases[0].features, hour: 24 }, metadata)).toThrow('час');
    expect(predictBrowserScalar(artifact, { ...cases[0].features, season: 'constructor' })).toBe(
      predictBrowserScalar(artifact, { ...cases[0].features, season: 'Зима' }));
  });
});
