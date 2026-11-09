import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPlanningClient, readConfiguration, validatePlanning, validateScenarios } from './client';

const fixture = (file: string) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/${file}`, import.meta.url), 'utf8'));
const demoEnv = { BASE_URL: '/LogisticsCase1/', VITE_DATA_MODE: 'demo' };
const json = (value: unknown) => Promise.resolve(new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }));

describe('shared contract and transport selection', () => {
  it('validates every canonical scenario and catalog', () => {
    expect(validateScenarios(fixture('scenarios.json'))).toBe(true);
    for (const id of ['morning', 'evening']) expect(validatePlanning(fixture(`${id}.json`))).toBe(true);
  });
  it('rejects incomplete and out-of-range planning responses', () => {
    const data = fixture('morning.json');
    data.data.corridors.features[0].properties.load_percent = 101;
    expect(validatePlanning(data)).toBe(false);
    expect(validatePlanning({ data: {} })).toBe(false);
  });
  it('resolves demo files under a GitHub Pages project base', async () => {
    const fetcher = vi.fn().mockImplementation(() => json(fixture('morning.json')));
    await createPlanningClient(demoEnv, fetcher).getScenario('morning');
    expect(fetcher.mock.calls[0][0]).toBe('/LogisticsCase1/demo/morning.json');
  });
  it('fetches the demo catalog from its local JSON file', async () => {
    const fetcher = vi.fn().mockImplementation(() => json(fixture('scenarios.json')));
    await createPlanningClient(demoEnv, fetcher).listScenarios();
    expect(fetcher.mock.calls[0][0]).toBe('/LogisticsCase1/demo/scenarios.json');
  });
  it('uses the configured API base independently of the frontend base path', async () => {
    const fetcher = vi.fn().mockImplementation(() => json(fixture('morning.json')));
    await createPlanningClient({ ...demoEnv, VITE_DATA_MODE: 'api', VITE_API_BASE_URL: 'https://api.example.test/planner/' }, fetcher).getScenario('morning');
    expect(fetcher.mock.calls[0][0]).toBe('https://api.example.test/planner/api/v1/scenarios/morning');
  });
  it('does not fall back to synthetic data when API requests fail', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('network'));
    await expect(createPlanningClient({ ...demoEnv, VITE_DATA_MODE: 'api', VITE_API_BASE_URL: 'https://api.example.test' }, fetcher).listScenarios()).rejects.toThrow('API недоступен');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('reports HTTP errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 503 }));
    await expect(createPlanningClient(demoEnv, fetcher).getScenario('morning')).rejects.toThrow('HTTP 503');
  });
  it('rejects a mismatched contract at the data boundary', async () => {
    const fetcher = vi.fn().mockImplementation(() => json({ data: [] }));
    await expect(createPlanningClient(demoEnv, fetcher).listScenarios()).rejects.toThrow('контракту');
  });
  it('rejects contradictory synthetic markers', async () => {
    const value = fixture('morning.json'); value.meta.is_synthetic = false;
    const fetcher = vi.fn().mockImplementation(() => json(value));
    await expect(createPlanningClient(demoEnv, fetcher).getScenario('morning')).rejects.toThrow('происхождения');
  });
  it('requires a valid explicit API configuration', () => {
    expect(() => readConfiguration({ BASE_URL: '/', VITE_DATA_MODE: 'ap1' })).toThrow('VITE_DATA_MODE');
    expect(() => readConfiguration({ BASE_URL: '/', VITE_DATA_MODE: 'api' })).toThrow('VITE_API_BASE_URL');
    expect(() => readConfiguration({ BASE_URL: '/', VITE_DATA_MODE: 'api', VITE_API_BASE_URL: 'javascript:bad' })).toThrow('HTTP(S)');
  });
});
