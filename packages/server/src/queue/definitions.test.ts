import { describe, expect, it } from 'vitest';
import { testConfig } from '../config/index.js';
import { RENDER_QUEUE_EXPIRY_MARGIN_S, queueDefinitions } from './definitions.js';

describe('the render queue definition', () => {
  it('expires a job 30 s after the render job time limit', () => {
    expect(RENDER_QUEUE_EXPIRY_MARGIN_S).toBe(30);
    for (const seconds of ['240', '300']) {
      const config = testConfig({ RENDER_MAX_JOB_DURATION_S: seconds });
      expect(config.queue.renderMaxJobDurationSeconds).toBe(Number(seconds));
      expect(queueDefinitions(config).render).toMatchObject({
        expireInSeconds: Number(seconds) + 30,
        deadLetter: 'render_dead',
      });
    }
  });
});
