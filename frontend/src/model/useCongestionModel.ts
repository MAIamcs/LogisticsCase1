import { useEffect, useState } from 'react';
import { createModelClient, type ModelFeatures, type ModelMetadata, type ModelPredictionResponse } from '../data/model-client';
import { latestRequestRunner } from '../forecast/latest-request';

export function useCongestionModel() {
  const [setup] = useState(() => {
    try { return { client: createModelClient(import.meta.env), error: '' }; }
    catch (error) { return { client: null, error: (error as Error).message }; }
  });
  const [metadata, setMetadata] = useState<ModelMetadata | null>(null);
  const [result, setResult] = useState<ModelPredictionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [predicting, setPredicting] = useState(false);
  const [error, setError] = useState(setup.error);
  const [revision, setRevision] = useState(0);
  const [requests] = useState(() => ({ metadata: latestRequestRunner(), prediction: latestRequestRunner() }));
  const [predictionRequest] = useState<{ cancel?: () => void }>(() => ({}));

  useEffect(() => {
    if (!setup.client) return;
    predictionRequest.cancel?.(); setPredicting(false); setResult(null);
    setLoading(true); setError(''); setMetadata(null);
    const request = requests.metadata.run(signal => setup.client!.getMetadata(signal), catalog => {
      setMetadata(catalog); setLoading(false);
    }, failure => { setError((failure as Error).message); setLoading(false); });
    return request.cancel;
  }, [setup, requests, predictionRequest, revision]);

  useEffect(() => () => predictionRequest.cancel?.(), [predictionRequest]);

  function clearPrediction() {
    predictionRequest.cancel?.(); setPredicting(false); setResult(null); setError('');
  }
  function predict(features: ModelFeatures) {
    if (!setup.client || !metadata || metadata.status !== 'ready') return;
    setPredicting(true); setResult(null); setError('');
    const request = requests.prediction.run(signal => setup.client!.predict(features, metadata, signal), prediction => {
      setResult(prediction); setPredicting(false);
    }, failure => { setError((failure as Error).message); setPredicting(false); });
    predictionRequest.cancel = request.cancel;
  }

  return {
    metadata, result, loading, predicting, error, mode: setup.client?.mode,
    predict, clearPrediction, reload: () => setRevision(value => value + 1),
    canReload: !!setup.client, loadGeographyLayer: setup.client?.loadGeographyLayer,
  };
}
