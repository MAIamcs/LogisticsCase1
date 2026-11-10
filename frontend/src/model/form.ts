import type { ModelFeatures, ModelMetadata } from '../data/model-client';
import { modelFeatureNames } from '../data/model-client';

export type ModelDraft = Record<keyof ModelFeatures, string>;

export function initialModelDraft(metadata: ModelMetadata): ModelDraft {
  const weekdays = metadata.features.find(feature => feature.name === 'day_of_week')?.options ?? [];
  return {
    hour: '12', district: '', is_main_road: '',
    day_of_week: weekdays.includes('Понедельник') ? 'Понедельник' : '',
    season: '',
    lanes_total: '', population: '',
  };
}

export function featuresFromDraft(draft: ModelDraft, metadata: ModelMetadata): ModelFeatures {
  for (const name of modelFeatureNames) {
    const definition = metadata.features.find(feature => feature.name === name);
    const raw = draft[name].trim();
    if (!definition || !raw) throw new Error(`Заполните поле «${definition?.label ?? name}».`);
    if (definition.kind === 'integer') {
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || definition.minimum != null && value < definition.minimum || definition.maximum != null && value > definition.maximum) {
        throw new Error(`Проверьте целое число в поле «${definition.label}».`);
      }
    } else if (definition.options?.length && !definition.options.includes(raw)) {
      throw new Error(`Выберите доступное значение в поле «${definition.label}».`);
    }
  }
  if (!metadata.districts.some(district => district.name === draft.district)) throw new Error('Выберите район из списка.');
  if (!['0', '1'].includes(draft.is_main_road)) throw new Error('Укажите тип дороги.');
  return {
    hour: Number(draft.hour), district: draft.district as ModelFeatures['district'],
    is_main_road: Number(draft.is_main_road) as 0 | 1,
    day_of_week: draft.day_of_week as ModelFeatures['day_of_week'], season: draft.season,
    lanes_total: Number(draft.lanes_total), population: Number(draft.population),
  };
}
