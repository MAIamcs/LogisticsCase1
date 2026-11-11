import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

const mocks = vi.hoisted(() => ({ workspace: {} as Record<string, unknown>, setSelection: vi.fn(), mapParameters: vi.fn() }));
vi.mock('../forecast/useForecastWorkspace', () => ({
  useForecastWorkspace: () => ({
    metadata: null, selection: null, result: null, loading: true, error: '',
    mode: 'demo', canReload: true, reload: vi.fn(), setSelection: mocks.setSelection, ...mocks.workspace,
  }),
}));
vi.mock('./MapParameters', async importOriginal => {
  const { MapParameters } = await importOriginal<typeof import('./MapParameters')>();
  return { MapParameters: (props: Parameters<typeof MapParameters>[0]) => {
    mocks.mapParameters(props);
    return <MapParameters {...props} />;
  } };
});

afterEach(() => {
  mocks.workspace = {};
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('application entry view', () => {
  it('opens planning first while keeping the trained model available as another view', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    const html = renderToStaticMarkup(<App />);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Планирование · demo/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Модель загруженности/);
    expect(html).toContain('<h1>Транспортное планирование</h1>');
    expect(html).not.toContain('<h1>Модель загруженности дорог</h1>');
  });

  it('retains trip demand when a district is selected and displays corridor totals', () => {
    const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../contracts/fixtures/forecast/${path}`, import.meta.url), 'utf8'));
    const metadata = read('metadata.json');
    const forecast = read('baseline/transport_demand/2030.json');
    const selection = { metric: 'transport_demand', year: 2030, scenario: 'baseline' };
    mocks.workspace = { metadata, selection, result: { forecast, series: [forecast], horizon: forecast }, loading: false };
    vi.stubGlobal('window', { location: { search: '' } });
    renderToStaticMarkup(<App />);
    mocks.mapParameters.mock.lastCall![0].onSelect('district-sovetsky');
    expect(mocks.setSelection).not.toHaveBeenCalled();

    vi.stubGlobal('window', { location: { search: '?metric=transport_demand&feature=district-sovetsky' } });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('value="transport_demand" selected=""');
    expect(html).toContain('value="district-sovetsky" selected=""');
    expect(html).toContain('Сводка по всем объектам показателя');
    expect(html).toContain('Все объекты. Выбранный, 2030:');
  });
});
