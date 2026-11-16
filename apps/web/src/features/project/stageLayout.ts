import { useSyncExternalStore } from 'react';
import type { Variant } from '@hailiday/core';

/**
 * The working grid a Street View look is rendered on. A look made from a Street View frame is
 * delivered at this size, so the frame is laid out at it too (scaled up from its own pixels)
 * wherever it stands in for the look that is coming: the picture keeps its size when the look
 * replaces it.
 */
export const STREET_VIEW_WORKING_SIZE = { width: 1024, height: 1024 } as const;

export interface PictureSize {
  width: number;
  height: number;
}

/**
 * The size a Street View source is laid out at: the newest look already made from it when there
 * is one (the size its next look will have), otherwise the working grid.
 */
export function streetViewLayoutSize(
  variants: readonly Variant[],
  sourceAssetId: string | null | undefined,
): PictureSize {
  if (sourceAssetId) {
    let newest: Variant | null = null;
    for (const variant of variants) {
      if (variant.sourceAssetId !== sourceAssetId) continue;
      if (!newest || variant.createdAt > newest.createdAt) newest = variant;
    }
    if (newest && newest.width > 0 && newest.height > 0) {
      return { width: newest.width, height: newest.height };
    }
  }
  return { ...STREET_VIEW_WORKING_SIZE };
}

/** Under 600px wide the stage's controls leave the picture for the paper under it. */
export const CONTROLS_BELOW_QUERY = '(max-width: 599.98px)';

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(CONTROLS_BELOW_QUERY)
    : null;
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  if (!list) return () => undefined;
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

function controlsBelow(): boolean {
  return query()?.matches ?? false;
}

/** Whether the stage's controls sit on the paper under it (phones) instead of on the picture. */
export function useControlsBelowStage(): boolean {
  return useSyncExternalStore(subscribe, controlsBelow, () => false);
}
