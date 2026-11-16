import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMs } from '../clock/index.js';
import type { RenderAsset, SourceAsset } from '../db/schema.js';
import { newId, randomToken, sha256Hex } from '../ids/index.js';
import { keys } from '../storage/keys.js';
import type { PipelineDeps } from './context.js';
import { runStreetViewRevalidation } from './jobs/commerce-and-coverage.js';
import { generateShareCard } from './jobs/share-card.js';
import { runRenderJob } from './render/job.js';
import { ReviewStateError, approveReview } from './render/review.js';
import { readJob } from './render/transitions.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from './testing.js';

/**
 * Worker-side decisions on Street View imagery credited to someone other than Google, under
 * `STREET_VIEW_CONTRIBUTOR_IMAGERY=display_only`: the render job's own evaluation, the share card,
 * revalidation and a reviewer's approval each read the setting from the deps they are given.
 */

/** The fixture place whose street photos stand in for contributor imagery (not Google's). */
const CONTRIBUTOR_PLACE = 'ChIJfxPinonMesaAdobeXXXXX17';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

/** The same deps with the contributor imagery setting at `display_only`. */
function displayOnly(deps: PipelineDeps): PipelineDeps {
  return {
    ...deps,
    config: {
      ...deps.config,
      streetView: { ...deps.config.streetView, contributorImagery: 'display_only' },
    },
  };
}

/** The same deps with the Street View framing on (`STREET_VIEW_FRAMING`). */
function framing(deps: PipelineDeps): PipelineDeps {
  return {
    ...deps,
    config: { ...deps.config, streetView: { ...deps.config.streetView, framing: true } },
  };
}

/** The same deps with the fixture Street View frame fetches counted. */
function counted(deps: PipelineDeps): { deps: PipelineDeps; fetches: () => number } {
  const fixture = deps.providers.fixtures.streetView;
  let fetches = 0;
  return {
    deps: {
      ...deps,
      providers: {
        ...deps.providers,
        fixtures: {
          ...deps.providers.fixtures,
          streetView: {
            ...fixture,
            fetchTransient: async (...args: Parameters<typeof fixture.fetchTransient>) => {
              fetches += 1;
              return fixture.fetchTransient(...args);
            },
          },
        },
      },
    },
    fetches: () => fetches,
  };
}

async function sourceRow(id: string): Promise<SourceAsset> {
  return base.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

function framingOf(source: Pick<SourceAsset, 'viewpoint'>): unknown {
  return (source.viewpoint as { framing?: unknown } | null)?.framing ?? null;
}

/** A stored (`persist`) contributor source decorated under the default setting, and its look. */
async function decoratedLook(): Promise<{
  made: Awaited<ReturnType<typeof createStreetViewSource>>;
  asset: RenderAsset;
  objectKey: string;
}> {
  const made = await createStreetViewSource(base, {
    placeId: CONTRIBUTOR_PLACE,
    streetViewMode: 'persist',
  });
  expect(made.source.isGoogleImagery).toBe(false);
  const job = await createRenderJobRecord(base, made);
  expect((await runRenderJob(base, { renderJobId: job.id })).state).toBe('succeeded');
  const asset = await base.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('jobId', '=', job.id)
    .executeTakeFirstOrThrow();
  expect(asset.distributable).toBe(true);
  const { objectKey } = await sourceRow(made.source.id);
  expect(objectKey).not.toBeNull();
  return { made, asset, objectKey: objectKey as string };
}

/** A live share grant of a look, as the API creates one (its card key named after its token). */
async function shareGrant(
  ownerId: string,
  asset: Pick<RenderAsset, 'id'>,
): Promise<{ id: string; token: string }> {
  const token = randomToken(16);
  const id = newId();
  await base.db
    .insertInto('shareGrants')
    .values({
      id,
      ownerId,
      renderAssetId: asset.id,
      tokenHash: sha256Hex(token),
      expiresAt: addMs(base.clock.now(), 30 * 86_400_000),
      shareCardObjectKey: keys.card(token),
    })
    .execute();
  return { id, token };
}

/** A user with the reviewer role. */
async function createReviewer(): Promise<string> {
  const ownerId = newId();
  await base.db.insertInto('owners').values({ id: ownerId, kind: 'user' }).execute();
  const userId = newId();
  await base.db
    .insertInto('users')
    .values({
      id: userId,
      ownerId,
      emailNormalized: `reviewer-${userId}@example.com`,
      roles: ['reviewer'],
    })
    .execute();
  return userId;
}

async function publicCopies(token: string): Promise<{ after: boolean; card: boolean }> {
  return {
    after: (await base.storage.head('public', keys.shared(token, 'after'))) !== null,
    card: (await base.storage.head('public', keys.card(token))) !== null,
  };
}

describe('contributor imagery switched to display_only, worker side', () => {
  it('refuses a job queued before the switch in the job itself; the same job runs under the default', async () => {
    const made = await createStreetViewSource(base, {
      placeId: CONTRIBUTOR_PLACE,
      streetViewMode: 'persist',
    });
    expect(made.source.isGoogleImagery).toBe(false);
    const job = await createRenderJobRecord(base, made);
    const refusing = counted(displayOnly(framing(base)));
    expect(await runRenderJob(refusing.deps, { renderJobId: job.id })).toEqual({
      state: 'failed',
      stopped: false,
    });
    const row = await base.db
      .selectFrom('renderJobs')
      .selectAll()
      .where('id', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: 'failed', failureKind: 'policy_denied' });
    const attemptsOf = (jobId: string) =>
      base.db.selectFrom('renderAttempts').select('id').where('jobId', '=', jobId).execute();
    const analysesOf = () =>
      base.db
        .selectFrom('sceneAnalyses')
        .select('id')
        .where('sourceAssetId', '=', made.source.id)
        .execute();
    expect(refusing.fetches()).toBe(0);
    expect(await analysesOf()).toHaveLength(0);
    expect(await attemptsOf(job.id)).toHaveLength(0);
    const refused = await sourceRow(made.source.id);
    expect(refused.objectKey).toBeNull();
    expect(framingOf(refused)).toBeNull();

    // The same job queued again under the default setting runs: it fetches, analyses, stores
    // and frames.
    const again = await createRenderJobRecord(base, made);
    const running = counted(framing(base));
    expect((await runRenderJob(running.deps, { renderJobId: again.id })).state).toBe('succeeded');
    expect(running.fetches()).toBeGreaterThan(0);
    expect((await analysesOf()).length).toBeGreaterThan(0);
    expect((await attemptsOf(again.id)).length).toBeGreaterThan(0);
    const stored = await sourceRow(made.source.id);
    expect(stored.objectKey).not.toBeNull();
    expect(framingOf(stored)).not.toBeNull();
  });

  it('writes no share card for a look of a frame that may only be displayed', async () => {
    const { made, asset } = await decoratedLook();
    const first = await shareGrant(made.ownerId, asset);
    const written = await generateShareCard(base, {
      shareGrantId: first.id,
      shareToken: first.token,
    });
    expect(written.outcome).toBe('written');
    expect(await publicCopies(first.token)).toEqual({ after: true, card: true });

    const second = await shareGrant(made.ownerId, asset);
    const skipped = await generateShareCard(displayOnly(base), {
      shareGrantId: second.id,
      shareToken: second.token,
    });
    expect(skipped).toEqual({ outcome: 'skipped', reason: 'not_distributable' });
    expect(await publicCopies(second.token)).toEqual({ after: false, card: false });
  });

  it('revalidation drops the stored frame and revokes the shares; under the default it keeps both', async () => {
    const { made, asset, objectKey } = await decoratedLook();
    const grants = [await shareGrant(made.ownerId, asset), await shareGrant(made.ownerId, asset)];
    for (const grant of grants) {
      const card = await generateShareCard(base, {
        shareGrantId: grant.id,
        shareToken: grant.token,
      });
      expect(card.outcome).toBe('written');
    }
    const grantRows = () =>
      base.db
        .selectFrom('shareGrants')
        .select(['id', 'revokedAt'])
        .where('renderAssetId', '=', asset.id)
        .execute();
    const due = () =>
      base.db
        .updateTable('sourceAssets')
        .set({ revalidatedAt: null })
        .where('id', '=', made.source.id)
        .execute();

    await due();
    const kept = await runStreetViewRevalidation(base, { sourceAssetIds: [made.source.id] });
    expect(kept).toMatchObject({ framesDropped: 0, sharesRevoked: 0 });
    expect((await sourceRow(made.source.id)).objectKey).toBe(objectKey);
    expect(await base.storage.head('private', objectKey)).not.toBeNull();
    expect((await grantRows()).map((grant) => grant.revokedAt)).toEqual([null, null]);
    for (const grant of grants) {
      expect(await publicCopies(grant.token)).toEqual({ after: true, card: true });
    }

    const live = (await grantRows()).filter((grant) => grant.revokedAt === null).length;
    expect(live).toBe(2);
    await due();
    const result = await runStreetViewRevalidation(displayOnly(base), {
      sourceAssetIds: [made.source.id],
    });
    expect(result).toMatchObject({ framesDropped: 1, sharesRevoked: live });
    expect((await sourceRow(made.source.id)).objectKey).toBeNull();
    expect(await base.storage.head('private', objectKey)).toBeNull();
    const revoked = await grantRows();
    expect(revoked).toHaveLength(2);
    for (const grant of revoked) expect(grant.revokedAt).toBeInstanceOf(Date);
    for (const grant of grants) {
      expect(await publicCopies(grant.token)).toEqual({ after: false, card: false });
    }
  });

  it('refuses the approval of a look held for review before the switch; under the default it is published', async () => {
    const made = await createStreetViewSource(base, {
      placeId: CONTRIBUTOR_PLACE,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(base, { ...made, reviewMode: 'pre_delivery' });
    expect((await runRenderJob(base, { renderJobId: job.id })).state).toBe('needs_review');
    const reviewer = await createReviewer();
    const reviewsOf = () =>
      base.db.selectFrom('reviews').select('decision').where('jobId', '=', job.id).execute();
    const assetsOf = () =>
      base.db.selectFrom('renderAssets').select('id').where('jobId', '=', job.id).execute();

    await expect(
      approveReview(displayOnly(base), { jobId: job.id, reviewerUserId: reviewer }),
    ).rejects.toBeInstanceOf(ReviewStateError);
    // Nothing was decided or published, and the look still waits for a reviewer.
    expect(await readJob(base.db, job.id)).toMatchObject({
      state: 'needs_review',
      reviewCompletedAt: null,
    });
    expect(await reviewsOf()).toEqual([]);
    expect(await assetsOf()).toEqual([]);

    const asset = await approveReview(base, { jobId: job.id, reviewerUserId: reviewer });
    expect(asset).toMatchObject({ jobId: job.id, distributable: true });
    expect(await readJob(base.db, job.id)).toMatchObject({ state: 'succeeded' });
    expect(await reviewsOf()).toEqual([{ decision: 'approve' }]);
  });
});
