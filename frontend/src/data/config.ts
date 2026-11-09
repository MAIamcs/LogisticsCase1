export type DataMode = 'demo' | 'api';
export type Environment = { VITE_DATA_MODE?: string; VITE_API_BASE_URL?: string; BASE_URL: string };

export function readConfiguration(env: Environment) {
  const mode = env.VITE_DATA_MODE || 'demo';
  if (mode !== 'demo' && mode !== 'api') throw new Error('VITE_DATA_MODE: укажите demo или api.');
  const baseUrl = env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '') || '';
  if (mode === 'api') {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('Для режима api задайте абсолютный VITE_API_BASE_URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      throw new Error('VITE_API_BASE_URL должен быть HTTP(S) URL без параметров и учетных данных.');
    }
    if (globalThis.location?.protocol === 'https:' && url.protocol !== 'https:') {
      throw new Error('Для HTTPS-страницы требуется HTTPS API.');
    }
  }
  return { mode: mode as DataMode, baseUrl, assetBase: env.BASE_URL };
}
