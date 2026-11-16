import type { LedgerSku } from '@hailiday/core';
import { budgetPaused } from '@hailiday/server/errors';
import { charge, unitPriceFor } from '@hailiday/server/ledger';
import { checkSpend } from '@hailiday/server/limits';
import type { DbOrTx } from '@hailiday/server/db';
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
  const now = deps.clock.now();
  const block = await spendBlockOf(deps, skus, isFixture, now);
  if (block) throw budgetPaused(block.reason, block.resumesAt, now);
}

/**
 * Whether the global pause and the spend ceilings allow paid calls of `skus` now: the check of
 * `assertSpendAllowed`, answered instead of thrown, for a read that leaves a paid item out.
 */
export async function spendAllowed(
  deps: Pick<ApiDeps, 'db' | 'settings' | 'clock'>,
  skus: readonly LedgerSku[],
  isFixture: boolean,
): Promise<boolean> {
  return (await spendBlockOf(deps, skus, isFixture, deps.clock.now())) === null;
}

async function spendBlockOf(
  deps: Pick<ApiDeps, 'db' | 'settings'>,
  skus: readonly LedgerSku[],
  isFixture: boolean,
  now: Date,
) {
  const additional = new Map<LedgerSku, number>();
  for (const sku of skus) additional.set(sku, (additional.get(sku) ?? 0) + unitPriceFor(sku));
  return checkSpend(deps.db, deps.settings, { now, additional, isFixture });
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
