/**
 * Kinds of allowance residue rows: a deleted address project (`address`), a deleted accepted
 * variant (`variant`) and a deleted paid attempt (`attempt`). Server-internal; never sent to
 * clients.
 */
export const ALLOWANCE_RESIDUE_KINDS = ['address', 'variant', 'attempt'] as const;
export type AllowanceResidueKind = (typeof ALLOWANCE_RESIDUE_KINDS)[number];
