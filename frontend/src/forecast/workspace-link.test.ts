import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ForecastMetadata } from '../data/forecast-client';
import { linkedFeature, linkedSelection, workspaceLink } from './workspace-link';

const metadata: ForecastMetadata = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/forecast/metadata.json', import.meta.url), 'utf8'));

describe('shareable workspace state', () => {
  it('restores the selected year, metric, scenario and object after a page refresh', () => {
    const state = { year: 2029, metric: 'population', scenario: 'compact' };
    const feature = 'district-sovetsky';
    const link = workspaceLink('https://maiamcs.github.io/LogisticsCase1/?source=review#main-content', metadata, state, feature);
    const refreshed = new URL(link, 'https://maiamcs.github.io');
    expect(refreshed.pathname).toBe('/LogisticsCase1/');
    expect(refreshed.hash).toBe('#main-content');
    expect(refreshed.searchParams.get('source')).toBe('review');
    expect(linkedSelection(metadata, refreshed.search)).toEqual(state);
    expect(linkedFeature(refreshed.search)).toBe(feature);
  });
  it('uses metadata defaults for unsupported link parameters and omits deleted objects', () => {
    const state = linkedSelection(metadata, '?year=2031&metric=unknown&scenario=unknown&feature=deleted');
    expect(state).toEqual({ year: metadata.base_year, metric: metadata.metrics[0].id, scenario: metadata.scenarios[0].id });
    const url = new URL(workspaceLink('https://example.test/LogisticsCase1/?feature=deleted', metadata, state, 'deleted'), 'https://example.test');
    expect(url.searchParams.has('feature')).toBe(false);
    expect(linkedSelection(metadata, '?year=2026junk').year).toBe(metadata.base_year);
    expect(linkedFeature(`?feature=${'x'.repeat(121)}`)).toBe('');
  });
  it('preserves a valid live selection on refresh and clears a deselected object from the link', () => {
    const current = { year: 2030, metric: 'infrastructure_load', scenario: 'baseline' };
    expect(linkedSelection(metadata, '?year=2026&metric=population', current)).toEqual(current);
    const link = workspaceLink('https://example.test/LogisticsCase1/?feature=district-sovetsky', metadata, current, '');
    expect(new URL(link, 'https://example.test').searchParams.has('feature')).toBe(false);
  });
});
