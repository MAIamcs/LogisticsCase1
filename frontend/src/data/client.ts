import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import planningSchema from '../../../contracts/schemas/planning-response.json';
import scenariosSchema from '../../../contracts/schemas/scenario-list-response.json';
import type { components } from '../../../contracts/api.generated';
import { readConfiguration, type Environment } from './config';
export { readConfiguration } from './config';
export type { DataMode, Environment } from './config';

export type PlanningResponse = components['schemas']['PlanningResponse'];
export type ScenarioListResponse = components['schemas']['ScenarioListResponse'];
export type Corridor = components['schemas']['CorridorFeature'];

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
export const validatePlanning = ajv.compile<PlanningResponse>(planningSchema);
export const validateScenarios = ajv.compile<ScenarioListResponse>(scenariosSchema);

export function createPlanningClient(env: Environment, fetcher: typeof fetch = fetch) {
  const config = readConfiguration(env);
  async function get<T>(path: string, validate: (value: unknown) => value is T, signal?: AbortSignal): Promise<T> {
    const url = config.mode === 'demo'
      ? `${config.assetBase}demo/${path === 'scenarios' ? 'scenarios' : encodeURIComponent(path.split('/')[1])}.json`
      : `${config.baseUrl}/api/v1/${path}`;
    const timeout = AbortSignal.timeout(15000);
    let response: Response;
    try {
      response = await fetcher(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: 'application/json' } });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(config.mode === 'api'
        ? 'API недоступен. Проверьте адрес сервера и CORS, затем повторите загрузку.'
        : 'Не удалось загрузить локальные демонстрационные данные.');
    }
    if (!response.ok) throw new Error(`Ошибка загрузки данных (HTTP ${response.status}).`);
    const value: unknown = await response.json();
    if (!validate(value)) throw new Error('Ответ не соответствует контракту API версии 1.0.');
    const meta = (value as { meta?: PlanningResponse['meta'] }).meta;
    if (meta && (meta.is_synthetic !== (meta.source === 'synthetic') || (config.mode === 'demo' && !meta.is_synthetic))) {
      throw new Error('Некорректная маркировка происхождения данных.');
    }
    return value;
  }
  return {
    mode: config.mode,
    listScenarios: (signal?: AbortSignal) => get('scenarios', validateScenarios, signal),
    getScenario: (id: string, signal?: AbortSignal) => get(`scenarios/${encodeURIComponent(id)}`, validatePlanning, signal),
  };
}
