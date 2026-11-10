import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelMetadata, ModelPredictionResponse } from '../data/model-client';
import { featuresFromDraft, initialModelDraft, type ModelDraft } from '../model/form';
import { CongestionForm, HourlyProfileChart } from './CongestionWorkspace';

const geography = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/forecast/geography.json', import.meta.url), 'utf8'));
const target: ModelMetadata['target'] = { id: 'congestion_index_0_10', name: 'Индекс загруженности', unit: 'балл', expected_min: 0, expected_max: 10, description: 'Оценка для заданного профиля дороги.' };
const metadata: ModelMetadata = {
  schema_version: '1.0', status: 'ready', model_version: 'test-cbm', model_sha256: 'a'.repeat(64), target,
  features: [
    { name: 'hour', label: 'Час', kind: 'integer', required: true, minimum: 0, maximum: 23, options: [] },
    { name: 'district', label: 'Район', kind: 'category', required: true, minimum: null, maximum: null, options: ['Советский', 'Центральный'] },
    { name: 'is_main_road', label: 'Магистральная дорога', kind: 'integer', required: true, minimum: 0, maximum: 1, options: [] },
    { name: 'day_of_week', label: 'День недели', kind: 'category', required: true, minimum: null, maximum: null, options: ['Понедельник', 'Вторник'] },
    { name: 'season', label: 'Сезон', kind: 'category', required: true, minimum: null, maximum: null, options: [] },
    { name: 'lanes_total', label: 'Полос всего', kind: 'integer', required: true, minimum: 1, maximum: null, options: [] },
    { name: 'population', label: 'Население', kind: 'integer', required: true, minimum: 0, maximum: null, options: [] },
  ],
  districts: [{ name: 'Советский', feature_id: 'district-sovetsky' }, { name: 'Центральный', feature_id: 'district-tsentralny' }],
  season_suggestions: ['Лето', 'Не лето'], has_year_feature: false, disclaimer: 'Результат одного профиля дороги.', geography, unavailable_reason: null,
};

function tagFor(html: string, name: string) {
  const tag = html.match(new RegExp(`<(?:input|select)[^>]*name="${name}"[^>]*>`))?.[0];
  expect(tag, `Expected a native form control named ${name}`).toBeDefined();
  return tag!;
}

describe('congestion model controls', () => {
  it('asks the user for road properties without inventing training defaults', () => {
    const draft = initialModelDraft(metadata);
    expect(draft).toMatchObject({ hour: '12', district: '', is_main_road: '', day_of_week: 'Понедельник', season: 'Не лето', lanes_total: '', population: '' });
    const html = renderToStaticMarkup(<CongestionForm metadata={metadata} draft={draft} onChange={() => {}} onSubmit={() => {}} predicting={false} />);
    for (const name of ['hour', 'district', 'is_main_road', 'day_of_week', 'season', 'lanes_total', 'population']) {
      expect(tagFor(html, name)).toContain('required');
    }
    expect(tagFor(html, 'lanes_total')).toContain('value=""');
    expect(tagFor(html, 'population')).toContain('value=""');
    expect(tagFor(html, 'lanes_total')).toContain('min="1"');
    expect(tagFor(html, 'population')).toContain('min="0"');
    expect(html).not.toMatch(/name="(?:year|scenario)"/);
  });

  it('offers metadata season suggestions while retaining free text input', () => {
    const draft = { ...initialModelDraft(metadata), season: 'Переходный сезон' };
    const html = renderToStaticMarkup(<CongestionForm metadata={metadata} draft={draft} onChange={() => {}} onSubmit={() => {}} predicting={false} />);
    const season = tagFor(html, 'season');
    expect(season).toContain('<input');
    expect(season).toContain('list=');
    expect(season).toContain('value="Переходный сезон"');
    expect(html).toContain('<datalist');
    expect(html).toContain('value="Лето"');
    expect(html).toContain('value="Не лето"');
  });

  it('uses a native submit control and exposes in-progress state', () => {
    const html = renderToStaticMarkup(<CongestionForm metadata={metadata} draft={initialModelDraft(metadata)} onChange={() => {}} onSubmit={() => {}} predicting />);
    expect(html).toMatch(/<button[^>]*type="submit"/);
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it('preserves observed zero and free-text season while rejecting missing or fractional road inputs', () => {
    const draft: ModelDraft = { ...initialModelDraft(metadata), district: 'Советский', is_main_road: '0', lanes_total: '2', population: '0', season: 'Переходный сезон' };
    expect(featuresFromDraft(draft, metadata)).toMatchObject({ population: 0, lanes_total: 2, is_main_road: 0, season: 'Переходный сезон' });
    expect(featuresFromDraft({ ...draft, season: ' Переходный сезон ' }, metadata).season).toBe(' Переходный сезон ');
    expect(() => featuresFromDraft({ ...draft, population: '' }, metadata)).toThrow();
    expect(() => featuresFromDraft({ ...draft, lanes_total: '2.5' }, metadata)).toThrow();
    expect(() => featuresFromDraft({ ...draft, hour: '24' }, metadata)).toThrow();
    expect(() => featuresFromDraft({ ...draft, district: 'Неизвестный' }, metadata)).toThrow();
  });
});

describe('model hourly profile', () => {
  const result: ModelPredictionResponse = {
    schema_version: '1.0', model_version: 'test-cbm', target,
    features: { hour: 12, district: 'Советский', is_main_road: 1, day_of_week: 'Понедельник', season: 'Не лето', lanes_total: 4, population: 0 },
    feature_id: 'district-sovetsky', prediction: { value: 10.125, unit: 'балл', out_of_expected_range: true },
    hourly_profile: Array.from({ length: 24 }, (_, hour) => ({ hour, value: hour === 12 ? 10.125 : hour / 3 })), warnings: [],
  };

  it('makes every hourly estimate available as text without attaching future-year semantics', () => {
    const html = renderToStaticMarkup(<HourlyProfileChart result={result} />);
    expect(html).toContain('<svg');
    expect(html).toContain('<table');
    for (let hour = 0; hour < 24; hour++) expect(html).toContain(`${hour}:00`);
    expect(html).toContain('10.125');
    expect(html).not.toContain('2030');
    expect(html).not.toContain('Критические интервалы');
    expect(html).not.toContain('доверительный');
    expect(html).not.toMatch(/NaN|Infinity/);
  });
});
