/** Cancels superseded work and guards commits even when a provider ignores abort. */
export function latestRequestRunner() {
  let active: AbortController | undefined;
  let generation = 0;
  return {
    run<T>(load: (signal: AbortSignal) => Promise<T>, commit: (value: T) => void, fail: (error: unknown) => void) {
      active?.abort();
      const controller = new AbortController(); active = controller;
      const request = ++generation;
      const isCurrent = () => request === generation && !controller.signal.aborted;
      const settled = (async () => {
        try {
          const value = await load(controller.signal);
          if (isCurrent()) commit(value);
        } catch (error) { if (isCurrent()) fail(error); }
      })();
      return { cancel: () => controller.abort(), settled };
    },
  };
}
