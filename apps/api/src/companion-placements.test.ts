import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecorationPlanSchema, VariantListResponseSchema } from '@holiday/core';
import { createRenderJobRecord } from '@holiday/server/pipeline';
import { createHarness, type Harness } from './test/harness.js';
import { adoptStreetViewProject } from './test/projects.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

/** Anchor categories of a decoration plan, each once in plan order. */
async function planCategories(decorationPlanId: string): Promise<string[]> {
  const plan = await harness.context.db
    .selectFrom('decorationPlans')
    .select('document')
    .where('id', '=', decorationPlanId)
    .executeTakeFirstOrThrow();
  const categories: string[] = [];
  for (const placement of DecorationPlanSchema.parse(plan.document).placements) {
    if (!categories.includes(placement.anchorCategory)) categories.push(placement.anchorCategory);
  }
  return categories;
}

describe('the daylight variant an evening job publishes as its relight base', () => {
  it('lists the placements of the attempt that rendered it', async () => {
    const client = harness.client({ remoteAddress: '10.77.0.1' });
    await client.createSession();
    const adopted = await adoptStreetViewProject(harness, client);
    const db = harness.context.db;
    const source = await db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', adopted.sourceAssetId)
      .executeTakeFirstOrThrow();
    // No daylight variant exists yet, so the evening job renders and publishes one first.
    const evening = await createRenderJobRecord(harness.pipeline, {
      ownerId: source.ownerId,
      projectId: adopted.projectId,
      source,
      lightingMode: 'evening',
    });
    expect(await harness.completeRender(evening.id)).toBe('succeeded');
    const baseAttempt = await db
      .selectFrom('renderAttempts')
      .select(['id', 'decorationPlanId'])
      .where('jobId', '=', evening.id)
      .where('attemptNo', '=', 1)
      .executeTakeFirstOrThrow();
    const expected = await planCategories(baseAttempt.decorationPlanId);
    expect(expected.length).toBeGreaterThan(0);

    const response = await client.get(`/v1/projects/${adopted.projectId}/variants`);
    expect(response.statusCode).toBe(200);
    const list = VariantListResponseSchema.parse(response.json());
    const daylight = list.items.find((item) => item.lightingMode === 'source');
    const relit = list.items.find((item) => item.lightingMode === 'evening');
    expect(relit?.renderJobId).toBe(evening.id);
    // The daylight variant belongs to a companion job without attempts of its own.
    expect(daylight?.renderJobId).toBeDefined();
    expect(daylight?.renderJobId).not.toBe(evening.id);
    const companionAttempts = await db
      .selectFrom('renderAttempts')
      .select('id')
      .where('jobId', '=', daylight?.renderJobId as string)
      .execute();
    expect(companionAttempts).toEqual([]);
    expect(daylight?.placements).toEqual(expected);

    // The companion job's own status serves the same variant with the same placements.
    const status = await client.get(`/v1/renders/${daylight?.renderJobId as string}`);
    expect(status.statusCode).toBe(200);
    expect((status.json() as { variant?: { placements?: string[] } }).variant?.placements).toEqual(
      expected,
    );
  });
});
