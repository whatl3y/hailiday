import type { Allowance, AllowanceGate } from '@holiday/core';
import { addressAllowance, variantAllowance, type CounterState } from '@holiday/server/limits';
import type { ApiDeps } from '../deps.js';
import { queuedRenderCount } from './capacity.js';

function counter(state: CounterState) {
  return {
    limit: state.limit,
    remaining: state.remaining,
    resetsAt: state.resetsAt ? state.resetsAt.toISOString() : null,
  };
}

/**
 * The `Allowance` object for an owner: accepted variants and new addresses in their rolling
 * windows, and the gate the interface shows before any tap (global pause, exhausted variants or
 * addresses, or a full render queue).
 */
export async function allowanceFor(
  deps: Pick<ApiDeps, 'db' | 'settings' | 'clock'>,
  ownerId: string | null,
): Promise<Allowance> {
  const now = deps.clock.now();
  const paused = await deps.settings.get('pause.global');
  if (!ownerId) {
    const variants = await deps.settings.get('allowance.variants_per_24h');
    const addresses = await deps.settings.get('allowance.addresses_per_24h');
    return {
      variants: { limit: variants, remaining: variants, resetsAt: null },
      addresses: { limit: addresses, remaining: addresses, resetsAt: null },
      gate: paused ? 'budget_paused' : 'none',
    };
  }
  const variants = await variantAllowance(deps.db, deps.settings, { ownerId, now });
  const addresses = await addressAllowance(deps.db, deps.settings, { ownerId, now });
  let gate: AllowanceGate = 'none';
  if (paused) gate = 'budget_paused';
  else if (variants.exhausted) gate = 'allowance_variants';
  else if (addresses.exhausted) gate = 'allowance_addresses';
  else {
    const maxDepth = await deps.settings.get('admission.max_queue_depth');
    if ((await queuedRenderCount(deps)) >= maxDepth && maxDepth > 0) gate = 'at_capacity';
  }
  return { variants: counter(variants), addresses: counter(addresses), gate };
}
