import type { LedgerSku } from '@holiday/core';
import { budgetPaused } from '@holiday/server/errors';
import { charge, unitPriceFor } from '@holiday/server/ledger';
import { checkSpend } from '@holiday/server/limits';
import type { DbOrTx } from '@holiday/server/db';
import type { ApiDeps } from '../deps.js';

/**
 * Checks the global pause and the spend ceilings before paid calls (Google calls on the address
 * path), throwing `BUDGET_PAUSED`. Fixture calls are exempt from ceilings but not from the pause.
 */
export async function assertSpendAllowed(
  deps: Pick<ApiDeps, 'db' | 'settings' | 'clock'>,
  skus: readonly LedgerSku[],
  isFixture: boolean,
): Promise<void> {
  const additional = new Map<LedgerSku, number>();
  for (const sku of skus) additional.set(sku, (additional.get(sku) ?? 0) + unitPriceFor(sku));
  const now = deps.clock.now();
  const block = await checkSpend(deps.db, deps.settings, { now, additional, isFixture });
  if (block) throw budgetPaused(block.reason, block.resumesAt, now);
}

/** Ledgers one address-path provider call as a `charge` row. */
export async function chargeCall(
  deps: Pick<ApiDeps, 'clock'>,
  db: DbOrTx,
  input: {
    sku: LedgerSku;
    provider: string;
    isFixture: boolean;
    ownerId: string;
    sessionId?: string | null;
    projectId?: string | null;
    units?: number;
    stage?: string;
  },
): Promise<void> {
  await charge(
    db,
    {
      ownerId: input.ownerId,
      sessionId: input.sessionId ?? null,
      projectId: input.projectId ?? null,
      isFixture: input.isFixture,
    },
    {
      provider: input.provider,
      sku: input.sku,
      units: input.units ?? 1,
      stage: input.stage ?? null,
    },
    deps.clock,
  );
}
