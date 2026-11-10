import type { QueueName } from '../queue/definitions.js';
import type { JobQueue, QueueJob } from '../queue/client.js';
import type { PipelineDeps } from './context.js';
import { runRenderJob } from './render/job.js';
import { failDeadUpload, settleDeadRender } from './render/dead-letter.js';
import { screenUpload } from './uploads/screen.js';
import { validateUpload } from './uploads/validate.js';
import { generateShareCard } from './jobs/share-card.js';
import { runAttemptSweep, runCoordinateExpiry, runRetentionSweep } from './jobs/sweeps.js';
import { runReconciliation } from './jobs/reconciliation.js';
import {
  runAffiliateReportImport,
  runCoverageProbe,
  runOfferVerification,
  runStreetViewRevalidation,
} from './jobs/commerce-and-coverage.js';

export type JobHandlers = { [N in QueueName]: (job: QueueJob<N>) => Promise<void> };

/** One handler per queue, each calling the pipeline function that owns the job. */
export function createJobHandlers(deps: PipelineDeps): JobHandlers {
  const log = deps.logger;
  const logged =
    <N extends QueueName>(name: N, run: (job: QueueJob<N>) => Promise<unknown>) =>
    async (job: QueueJob<N>) => {
      const started = Date.now();
      const result = await run(job);
      log.info(
        { queue: name, jobId: job.id, durationMs: Date.now() - started, result },
        'job done',
      );
    };
  return {
    render: logged('render', (job) =>
      runRenderJob(deps, {
        renderJobId: job.data.renderJobId,
        signal: job.signal,
        retryCount: job.retryCount,
      }),
    ),
    render_dead: logged('render_dead', (job) =>
      settleDeadRender(deps, { renderJobId: job.data.renderJobId }),
    ),
    upload_validate: logged('upload_validate', (job) => validateUpload(deps, job.data)),
    upload_validate_dead: logged('upload_validate_dead', (job) => failDeadUpload(deps, job.data)),
    upload_screen: logged('upload_screen', (job) => screenUpload(deps, job.data)),
    upload_screen_dead: logged('upload_screen_dead', (job) => failDeadUpload(deps, job.data)),
    share_card: logged('share_card', (job) => generateShareCard(deps, job.data)),
    retention_sweep: logged('retention_sweep', (job) =>
      runRetentionSweep(deps, job.data.limit ? { limit: job.data.limit } : {}),
    ),
    attempt_sweep: logged('attempt_sweep', (job) =>
      runAttemptSweep(deps, job.data.limit ? { limit: job.data.limit } : {}),
    ),
    coordinate_expiry: logged('coordinate_expiry', () => runCoordinateExpiry(deps)),
    reconciliation: logged('reconciliation', (job) =>
      runReconciliation(deps, job.data.limit ? { limit: job.data.limit } : {}),
    ),
    street_view_revalidation: logged('street_view_revalidation', (job) =>
      runStreetViewRevalidation(deps, job.data.limit ? { limit: job.data.limit } : {}),
    ),
    offer_verification: logged('offer_verification', () => runOfferVerification(deps)),
    affiliate_report_import: logged('affiliate_report_import', () =>
      runAffiliateReportImport(deps),
    ),
    coverage_probe: logged('coverage_probe', (job) => runCoverageProbe(deps, job.data)),
  };
}

/**
 * Local concurrency per queue: renders are bounded by the worker setting and the image-edit
 * provider's concurrency, screening by the vision provider's; the rest run one or two at a time.
 */
export async function consumerConcurrency(
  deps: Pick<PipelineDeps, 'config' | 'settings'>,
): Promise<Record<QueueName, number>> {
  const editor = deps.config.providers.imageEditor;
  const vision = deps.config.providers.vision;
  const editorLimit = await deps.settings.providerConcurrency(editor);
  const visionLimit = await deps.settings.providerConcurrency(vision);
  return {
    render: Math.max(1, Math.min(deps.config.queue.renderWorkerConcurrency, editorLimit)),
    render_dead: 1,
    upload_validate: 2,
    upload_validate_dead: 1,
    upload_screen: Math.max(1, Math.min(4, visionLimit)),
    upload_screen_dead: 1,
    share_card: 2,
    retention_sweep: 1,
    attempt_sweep: 1,
    coordinate_expiry: 1,
    reconciliation: 1,
    street_view_revalidation: 1,
    offer_verification: 1,
    affiliate_report_import: 1,
    coverage_probe: 1,
  };
}

/** Registers every queue consumer on a worker-role queue. Returns the concurrency used. */
export async function registerConsumers(
  queue: JobQueue,
  deps: PipelineDeps,
  options: { pollingIntervalSeconds?: number } = {},
): Promise<Record<QueueName, number>> {
  const handlers = createJobHandlers(deps);
  const concurrency = await consumerConcurrency(deps);
  for (const name of Object.keys(handlers) as QueueName[]) {
    await queue.work(name, handlers[name] as (job: QueueJob<typeof name>) => Promise<void>, {
      localConcurrency: concurrency[name],
      ...(options.pollingIntervalSeconds !== undefined
        ? { pollingIntervalSeconds: options.pollingIntervalSeconds }
        : {}),
    });
  }
  return concurrency;
}
