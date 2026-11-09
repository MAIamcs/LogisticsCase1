import { describe, expect, it, vi } from 'vitest';
import { latestRequestRunner } from './latest-request';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('quick request switches', () => {
  it('commits only the newest response even when the old provider ignores cancellation', async () => {
    const runner = latestRequestRunner(); const old = deferred<string>(); const current = deferred<string>();
    const commit = vi.fn(); const fail = vi.fn(); let oldSignal: AbortSignal | undefined;
    const first = runner.run(signal => { oldSignal = signal; return old.promise; }, commit, fail);
    const second = runner.run(() => current.promise, commit, fail);
    expect(oldSignal?.aborted).toBe(true);
    current.resolve('selected scenario'); await second.settled;
    old.resolve('obsolete scenario'); await first.settled;
    expect(commit.mock.calls).toEqual([['selected scenario']]); expect(fail).not.toHaveBeenCalled();
  });
  it('does not let a superseded error clear newer successful data', async () => {
    const runner = latestRequestRunner(); const old = deferred<string>(); const commit = vi.fn(); const fail = vi.fn();
    const first = runner.run(() => old.promise, commit, fail);
    await runner.run(async () => 'current metric', commit, fail).settled;
    old.reject(new Error('old failure')); await first.settled;
    expect(commit.mock.calls).toEqual([['current metric']]); expect(fail).not.toHaveBeenCalled();
  });
  it('ignores results after cleanup and reports a current error for retry', async () => {
    const runner = latestRequestRunner(); const pending = deferred<string>(); const commit = vi.fn(); const fail = vi.fn();
    const request = runner.run(() => pending.promise, commit, fail);
    request.cancel(); pending.resolve('unmounted'); await request.settled;
    expect(commit).not.toHaveBeenCalled();
    await runner.run(async () => { throw new Error('current outage'); }, commit, fail).settled;
    expect(fail.mock.calls[0][0]).toMatchObject({ message: 'current outage' });
    await runner.run(async () => 'retry succeeds', commit, fail).settled;
    expect(commit.mock.calls).toEqual([['retry succeeds']]);
  });
});
