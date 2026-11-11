import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

vi.mock('../forecast/useForecastWorkspace', () => ({
  useForecastWorkspace: () => ({
    metadata: null, selection: null, result: null, loading: true, error: '',
    mode: 'demo', canReload: true, reload: vi.fn(), setSelection: vi.fn(),
  }),
}));

afterEach(() => vi.unstubAllGlobals());

describe('application entry view', () => {
  it('opens planning first while keeping the trained model available as another view', () => {
    vi.stubGlobal('window', { location: { search: '' } });
    const html = renderToStaticMarkup(<App />);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Планирование · demo/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Модель загруженности/);
    expect(html).toContain('<h1>Транспортное планирование</h1>');
    expect(html).not.toContain('<h1>Модель загруженности дорог</h1>');
  });
});
