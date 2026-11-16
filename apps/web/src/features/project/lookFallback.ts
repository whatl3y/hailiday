import { create } from 'zustand';
import type { LightingMode } from '@hailiday/core';

/** A lighting the job makes in a second pass over the decorated photo. */
export type RelitLighting = Extract<LightingMode, 'evening' | 'bright'>;

export interface LightFallback {
  /** The variant shown in the photo's own light because its relit look did not arrive. */
  renderAssetId: string;
  /** The lighting that look was asked in. */
  lightingMode: RelitLighting;
}

interface LightFallbackState {
  fallback: LightFallback | null;
  /** The person closed the line about it; the look still counts as the relit look's stand-in. */
  dismissed: boolean;
}

/**
 * Marks the variant that stands in for a relit look (evening, bright) whose light did not arrive,
 * so the result says so under the picture and offers the light again. Cleared as soon as another
 * look is chosen, shown or started.
 */
export const useLightFallback = create<LightFallbackState>()(() => ({
  fallback: null,
  dismissed: false,
}));

export function setLightFallback(fallback: LightFallback | null): void {
  const current = useLightFallback.getState();
  if (
    !current.dismissed &&
    current.fallback?.renderAssetId === fallback?.renderAssetId &&
    current.fallback?.lightingMode === fallback?.lightingMode
  ) {
    return;
  }
  useLightFallback.setState({ fallback, dismissed: false });
}

/** Closes the line under the picture; the look on screen keeps standing in for the relit look. */
export function dismissLightFallback(): void {
  if (!useLightFallback.getState().fallback) return;
  useLightFallback.setState({ dismissed: true });
}

/** Whether a relit look's daylight stand-in is the variant on screen. */
export function standsInFor(renderAssetId: string): RelitLighting | null {
  const { fallback } = useLightFallback.getState();
  return fallback?.renderAssetId === renderAssetId ? fallback.lightingMode : null;
}
