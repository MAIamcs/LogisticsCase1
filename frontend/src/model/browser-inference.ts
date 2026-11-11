/** Inference-only interpreter of CatBoost's exported oblivious trees and CTRs. */
import type { ModelFeatures, ModelMetadata, ModelPredictionResponse } from '../data/model-client';

type Ctr = { base_hash: string; base_ctr_type: string; target_border_idx: number; prior_num: number; prior_denom: number; shift: number; scale: number };
type Projection = { transposed_cat_feature_indexes: number[]; binarized_indexes: { bin_index: number; check_value_equal: boolean; value: number }[] };
type CtrTable = { index_hash_viewer: Record<string, number>; target_classes_count: number; counter_denominator: number; ctr_mean_history: { sum: number; count: number }[]; ctr_total: number[] };
type ModelData = {
  float_features_index: number[]; float_feature_borders: number[][]; binary_feature_count: number;
  one_hot_cat_feature_index: number[]; one_hot_hash_values: number[][]; ctr_feature_borders: number[][];
  model_ctrs: { compressed_model_ctrs: { projection: Projection; model_ctrs: Ctr[] }[]; ctr_data: { learn_ctrs: Record<string, CtrTable> } };
  tree_count: number; tree_depth: number[]; tree_split_border: number[]; tree_split_feature_index: number[]; tree_split_xor_mask: number[];
  leaf_values: number[]; scale: number; biases: number[];
};
export type BrowserModel = { schema_version: '1.0'; model_sha256: string; feature_names: string[]; categorical_hashes: Record<string, number>; data: ModelData };
const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const multiplier = 0x4906ba494954cb65n;
const hash = (a: bigint, b: number | bigint) => BigInt.asUintN(64, multiplier * BigInt.asUintN(64, a + multiplier * BigInt(b)));

function projectionHash(projection: Projection, binary: number[], categories: number[]) {
  let result = 0n;
  for (const index of projection.transposed_cat_feature_indexes) result = hash(result, categories[index]);
  for (const feature of projection.binarized_indexes) {
    const value = binary[feature.bin_index];
    result = hash(result, Number(feature.check_value_equal ? value === feature.value : value >= feature.value));
  }
  return result.toString();
}

function ctrValue(ctr: Ctr, table: CtrTable, key: string) {
  const bucket = table.index_hash_viewer[key];
  let good = 0; let total = 0;
  if (bucket !== undefined) {
    const kind = ctr.base_ctr_type;
    if (kind === 'BinarizedTargetMeanValue' || kind === 'FloatTargetMeanValue') {
      good = table.ctr_mean_history[bucket].sum; total = table.ctr_mean_history[bucket].count;
    } else if (kind === 'Counter' || kind === 'FeatureFreq') {
      good = table.ctr_total[bucket]; total = table.counter_denominator;
    } else {
      const count = table.target_classes_count;
      for (let index = 0; index < count; index++) {
        const value = table.ctr_total[bucket * count + index];
        total += value;
        if (kind === 'Buckets' ? index === ctr.target_border_idx : index > ctr.target_border_idx) good += value;
      }
    }
  }
  return ((good + ctr.prior_num) / (total + ctr.prior_denom) + ctr.shift) * ctr.scale;
}

export function predictBrowserScalar(artifact: BrowserModel, features: ModelFeatures): number {
  const day = weekdays.indexOf(features.day_of_week);
  if (!Number.isInteger(features.hour) || features.hour < 0 || features.hour > 23 || day < 0
    || ![0, 1].includes(features.is_main_road) || !Number.isSafeInteger(features.lanes_total) || features.lanes_total < 1
    || !Number.isSafeInteger(features.population) || features.population < 0 || !features.season.trim()) throw new Error('Проверьте семь входных признаков модели.');
  const floats = [features.hour, features.is_main_road, features.lanes_total, features.population,
    Math.sin(2 * Math.PI * features.hour / 24), Math.cos(2 * Math.PI * features.hour / 24),
    Math.sin(2 * Math.PI * day / 7), Math.cos(2 * Math.PI * day / 7)].map(Math.fround);
  const categories = [features.district, features.day_of_week, features.season].map(value =>
    Object.hasOwn(artifact.categorical_hashes, value) ? artifact.categorical_hashes[value] : 0x7fffffff);
  const model = artifact.data;
  const binary = new Array<number>(model.binary_feature_count).fill(0);
  let offset = 0;
  for (let index = 0; index < model.float_feature_borders.length; index++) {
    for (const border of model.float_feature_borders[index]) binary[offset] += Number(floats[model.float_features_index[index]] > border);
    offset++;
  }
  for (let index = 0; index < model.one_hot_cat_feature_index.length; index++) {
    const value = categories[model.one_hot_cat_feature_index[index]];
    for (let border = 0; border < model.one_hot_hash_values[index].length; border++) binary[offset] |= Number(value === model.one_hot_hash_values[index][border]) * (border + 1);
    offset++;
  }
  let ctrIndex = 0;
  for (const group of model.model_ctrs.compressed_model_ctrs) {
    const key = projectionHash(group.projection, binary, categories);
    for (const ctr of group.model_ctrs) {
      const value = ctrValue(ctr, model.model_ctrs.ctr_data.learn_ctrs[ctr.base_hash], key);
      for (const border of model.ctr_feature_borders[ctrIndex++]) binary[offset] += Number(value > border);
      offset++;
    }
  }
  let split = 0; let leaves = 0; let result = 0;
  for (let tree = 0; tree < model.tree_count; tree++) {
    let leaf = 0;
    const depth = model.tree_depth[tree];
    for (let bit = 0; bit < depth; bit++) {
      const index = split + bit;
      leaf |= Number((binary[model.tree_split_feature_index[index]] ^ model.tree_split_xor_mask[index]) >= model.tree_split_border[index]) << bit;
    }
    result += model.leaf_values[leaves + leaf]; split += depth; leaves += 1 << depth;
  }
  const prediction = model.scale * result + model.biases[0];
  if (!Number.isFinite(prediction)) throw new Error('Модель вернула нечисловой результат.');
  return prediction;
}

export function predictBrowserModel(artifact: BrowserModel, features: ModelFeatures, metadata: ModelMetadata): ModelPredictionResponse {
  if (artifact.schema_version !== '1.0' || artifact.model_sha256 !== metadata.model_sha256) throw new Error('Версия файла модели не соответствует метаданным. Обновите страницу.');
  if (!Number.isInteger(features.hour) || features.hour < 0 || features.hour > 23) throw new Error('Введите час от 0 до 23.');
  const district = metadata.districts.find(item => item.name === features.district);
  if (!district) throw new Error('Выберите район из списка.');
  const hourly_profile = Array.from({ length: 24 }, (_, hour) => ({ hour, value: predictBrowserScalar(artifact, { ...features, hour }) }));
  const value = hourly_profile[features.hour].value;
  return {
    schema_version: '1.0', model_version: metadata.model_version, target: metadata.target, features,
    feature_id: district.feature_id, prediction: { value, unit: 'балл', out_of_expected_range: value < 0 || value > 10 }, hourly_profile,
    warnings: ['Результат вычислен в браузере по предоставленной CatBoost.',
      'Расчётный индекс относится к выбранному профилю дороги. В обучающем наборе представлен один профиль главной дороги на район.'],
  };
}
