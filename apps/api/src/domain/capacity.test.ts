import { describe, expect, it } from 'vitest';
import { admissionDecision, renderLanes, retryAfterFor } from './capacity.js';
import type { ApiDeps } from '../deps.js';

function lanesDeps(workers: number, provider: number) {
  return {
    config: { queue: { renderWorkerConcurrency: workers }, providers: { imageEditor: 'openai' } },
    settings: {
      providerConcurrency: async (name: string) => (name === 'openai' ? provider : 99),
    },
  } as unknown as Pick<ApiDeps, 'config' | 'settings'>;
}

describe('admission control', () => {
  it('runs as many lanes as the smaller of the worker and provider concurrency', async () => {
    expect(await renderLanes(lanesDeps(6, 2))).toBe(2);
    expect(await renderLanes(lanesDeps(2, 6))).toBe(2);
    expect(await renderLanes(lanesDeps(0, 0))).toBe(1);
  });

  it('refuses when the provider concurrency makes the predicted wait too long', async () => {
    const lanes = await renderLanes(lanesDeps(6, 2));
    const decision = admissionDecision({
      queued: 30,
      p50Seconds: 45,
      lanes,
      maxQueueDepth: 36,
      maxWaitSeconds: 240,
    });
    expect(decision.estimatedWait).toBe(698);
    expect(decision.retryAfter).toBe(300);
  });

  it('admits a short queue', () => {
    expect(
      admissionDecision({
        queued: 3,
        p50Seconds: 45,
        lanes: 2,
        maxQueueDepth: 36,
        maxWaitSeconds: 240,
      }),
    ).toEqual({ estimatedWait: 90, retryAfter: null });
  });

  it('sets Retry-After to the predicted wait rounded up to 30 s, within 30 to 300 s', () => {
    expect(retryAfterFor(70)).toBe(90);
    expect(retryAfterFor(5)).toBe(30);
    expect(retryAfterFor(90)).toBe(90);
    expect(retryAfterFor(4_000)).toBe(300);
    // A full queue refuses even with a short wait.
    expect(
      admissionDecision({
        queued: 36,
        p50Seconds: 1,
        lanes: 6,
        maxQueueDepth: 36,
        maxWaitSeconds: 240,
      }).retryAfter,
    ).toBe(30);
  });
});
