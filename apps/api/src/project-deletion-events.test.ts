import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pipeline from '@hailiday/server/pipeline';
import { sessionHashOf } from './auth/session.js';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient } from './test/operator.js';
import { adoptStreetViewProject, ownerIdOf } from './test/projects.js';

vi.mock('@hailiday/server/pipeline', async (importOriginal) => {
  const original = await importOriginal<typeof pipeline>();
  return { ...original, deleteProject: vi.fn(original.deleteProject) };
});

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({
    overrides: { SESSION_SECRET: 'deletion-events-test-session-secret-0123456789' },
  });
});

afterAll(async () => {
  await harness?.close();
});

/** An address project of the client's owner with one rendered variant. */
async function projectWithVariant(client: TestClient) {
  const project = await adoptStreetViewProject(harness, client);
  const source = await harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', project.sourceAssetId)
    .executeTakeFirstOrThrow();
  const job = await pipeline.createRenderJobRecord(harness.pipeline, {
    ownerId: source.ownerId,
    projectId: project.projectId,
    source,
  });
  expect(await harness.completeRender(job.id)).toBe('succeeded');
  return project;
}

/** Lets every `deleteProject` call wait until `count` calls have arrived, then run. */
function holdDeletionsUntil(count: number) {
  const original = vi.mocked(pipeline.deleteProject).getMockImplementation();
  if (!original) throw new Error('deleteProject is not wrapped');
  let arrived = 0;
  let release: () => void = () => {};
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(pipeline.deleteProject).mockImplementation(async (...args) => {
    arrived += 1;
    if (arrived === count) release();
    await allArrived;
    return original(...args);
  });
  return {
    arrived: () => arrived,
    restore: () => vi.mocked(pipeline.deleteProject).mockImplementation(original),
  };
}

async function newOwner(remoteAddress: string): Promise<TestClient> {
  const client = harness.client({ remoteAddress });
  await client.createSession();
  return client;
}

/** The `project_deleted` events recorded for the client's owner. */
async function deletionEvents(client: TestClient) {
  const sessionHash = sessionHashOf(harness.server.deps, await ownerIdOf(harness, client));
  return harness.context.db
    .selectFrom('analyticsEvents')
    .select(['properties'])
    .where('eventName', '=', 'project_deleted')
    .where('sessionHash', '=', sessionHash)
    .execute();
}

describe('the project_deleted event', () => {
  it('is emitted once for a single deletion', async () => {
    const client = await newOwner('10.74.0.1');
    const project = await adoptStreetViewProject(harness, client);
    const response = await client.delete(`/v1/projects/${project.projectId}`);
    expect(response.statusCode).toBe(202);
    expect(json(response).status).toBe('completed');
    const events = await deletionEvents(client);
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({ scope: 'project' });
    // Repeating the request returns the same deletion and records nothing more.
    const repeat = await client.delete(`/v1/projects/${project.projectId}`);
    expect(json(repeat).deletionRequestId).toBe(json(response).deletionRequestId);
    expect(await deletionEvents(client)).toHaveLength(1);
  });

  it('is emitted once when two concurrent requests join one deletion', async () => {
    const client = await newOwner('10.74.0.2');
    const project = await adoptStreetViewProject(harness, client);
    const original = vi.mocked(pipeline.deleteProject).getMockImplementation();
    if (!original) throw new Error('deleteProject is not wrapped');
    // Both requests pass the route's checks before either starts the deletion.
    let arrived = 0;
    let release: () => void = () => {};
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(pipeline.deleteProject).mockImplementation(async (...args) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      return original(...args);
    });
    try {
      const [first, second] = await Promise.all([
        client.delete(`/v1/projects/${project.projectId}`),
        client.delete(`/v1/projects/${project.projectId}`),
      ]);
      expect(arrived).toBe(2);
      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      expect(json(first).deletionRequestId).toBe(json(second).deletionRequestId);
      const requests = await harness.context.db
        .selectFrom('deletionRequests')
        .select(['status'])
        .where('targetId', '=', project.projectId)
        .execute();
      expect(requests).toEqual([{ status: 'completed' }]);
      expect(await deletionEvents(client)).toHaveLength(1);
    } finally {
      vi.mocked(pipeline.deleteProject).mockImplementation(original);
    }
  });

  it('is emitted once when two concurrent requests find the deletion held', async () => {
    const client = await newOwner('10.74.0.3');
    const project = await projectWithVariant(client);
    const { client: operator, csrf } = await operatorClient(harness);
    const placed = await operator.post(
      '/internal/v1/preservation-holds',
      {
        targetKind: 'project',
        targetId: project.projectId,
        reason: 'complaint_investigation',
        authorityRef: 'case-deletion-events',
        releaseCondition: 'investigation closed',
      },
      { 'x-csrf-token': csrf },
    );
    expect(placed.statusCode).toBe(201);
    const gate = holdDeletionsUntil(2);
    try {
      const [first, second] = await Promise.all([
        client.delete(`/v1/projects/${project.projectId}`),
        client.delete(`/v1/projects/${project.projectId}`),
      ]);
      expect(gate.arrived()).toBe(2);
      expect(json(first)).toMatchObject({ status: 'held' });
      expect(json(second)).toMatchObject({ status: 'held' });
      expect(json(first).deletionRequestId).toBe(json(second).deletionRequestId);
      const events = await deletionEvents(client);
      expect(events).toHaveLength(1);
      expect(events[0]?.properties).toMatchObject({ scope: 'project', variantCount: 1 });
    } finally {
      gate.restore();
    }
    // A later request finds the deletion held and records nothing more.
    const repeat = await client.delete(`/v1/projects/${project.projectId}`);
    expect(json(repeat)).toMatchObject({ status: 'held' });
    expect(await deletionEvents(client)).toHaveLength(1);
  });

  it('is emitted by a repeated request that completes an interrupted deletion', async () => {
    const client = await newOwner('10.74.0.4');
    const project = await projectWithVariant(client);
    // The first request revokes access and creates the deletion request, then fails before its
    // completion removes anything.
    vi.mocked(pipeline.deleteProject).mockImplementationOnce(async (deps, input) => {
      await pipeline.beginProjectDeletion(deps, input);
      throw new Error('storage unavailable');
    });
    const failed = await client.delete(`/v1/projects/${project.projectId}`);
    expect(failed.statusCode).toBe(500);
    expect(await deletionEvents(client)).toHaveLength(0);
    const request = await harness.context.db
      .selectFrom('deletionRequests')
      .select(['id', 'status'])
      .where('targetId', '=', project.projectId)
      .executeTakeFirstOrThrow();
    expect(request.status).toBe('in_progress');

    const resumed = await client.delete(`/v1/projects/${project.projectId}`);
    expect(resumed.statusCode).toBe(202);
    expect(json(resumed)).toEqual({ deletionRequestId: request.id, status: 'completed' });
    const remaining = await harness.context.db
      .selectFrom('projects')
      .select('id')
      .where('id', '=', project.projectId)
      .execute();
    expect(remaining).toEqual([]);
    const events = await deletionEvents(client);
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({ scope: 'project', variantCount: 1 });

    // The deletion is complete: repeating the request records nothing more.
    const again = await client.delete(`/v1/projects/${project.projectId}`);
    expect(json(again)).toEqual({ deletionRequestId: request.id, status: 'completed' });
    expect(await deletionEvents(client)).toHaveLength(1);
  });
});
