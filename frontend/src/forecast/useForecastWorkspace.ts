import { useEffect, useState } from 'react';
import { createForecastClient, type ForecastMetadata, type ForecastResponse, type ForecastSelection } from '../data/forecast-client';
import { errorLabel } from './presentation';
import { linkedSelection } from './workspace-link';
import { latestRequestRunner } from './latest-request';

export function useForecastWorkspace() {
  const [setup] = useState(() => {
    try { return { client: createForecastClient(import.meta.env), error: '' }; }
    catch (error) { return { client: null, error: (error as Error).message }; }
  });
  const [metadata, setMetadata] = useState<ForecastMetadata | null>(null);
  const [selection, setSelection] = useState<ForecastSelection | null>(null);
  const [bundle, setBundle] = useState<{ metric: string; scenario: string; version: string; series: ForecastResponse[] } | null>(null);
  const [error, setError] = useState(setup.error);
  const [loading, setLoading] = useState(Boolean(setup.client));
  const [revision, setRevision] = useState(0);
  const [requests] = useState(() => ({ metadata: latestRequestRunner(), series: latestRequestRunner() }));

  useEffect(() => {
    if (!setup.client) return;
    setLoading(true); setError(''); setMetadata(null); setBundle(null);
    const request = requests.metadata.run(signal => setup.client!.getMetadata(signal), catalog => {
      setMetadata(catalog);
      setSelection(current => linkedSelection(catalog, window.location.search, current));
    }, error => {
      setError(errorLabel(error, setup.client?.mode)); setLoading(false);
    });
    return request.cancel;
  }, [setup, requests, revision]);

  const metric = selection?.metric;
  const scenario = selection?.scenario;
  useEffect(() => {
    if (!setup.client || !metadata || !metric || !scenario) return;
    setLoading(true); setError(''); setBundle(null);
    const request = requests.series.run(signal => setup.client!.getForecastSeries(metadata, metric, scenario, signal), series => {
      setBundle({ metric, scenario, version: metadata.data_version, series }); setLoading(false);
    }, error => {
      setError(errorLabel(error, setup.client?.mode)); setLoading(false);
    });
    return request.cancel;
  }, [setup, requests, metadata, metric, scenario]);

  // A year switch selects one immutable response from the already validated
  // series. Map, legend, card, KPIs and charts share that single render identity.
  const current = bundle && metadata && selection && bundle.metric === selection.metric
    && bundle.scenario === selection.scenario && bundle.version === metadata.data_version ? bundle : null;
  const forecast = current?.series.find(response => response.forecast_year === selection?.year);
  const result = forecast && current ? { forecast, series: current.series, horizon: current.series[current.series.length - 1] } : null;
  return {
    metadata, selection, setSelection, result, error, loading, mode: setup.client?.mode,
    canReload: Boolean(setup.client), reload: () => setRevision(value => value + 1),
    loadGeographyLayer: setup.client?.getGeographyLayer,
  };
}
