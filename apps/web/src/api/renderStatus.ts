import {
  CreateRenderResponseSchema,
  RenderStatusSchema,
  STAGE_LABEL_KEYS,
  VariantListResponseSchema,
} from '@hailiday/core';

/** The stage a Street View look reports while the job zooms in on the home in the frame. */
export const FRAMING_STAGE = 'stage.framing';

const CORE_STAGES = new Set<string>(STAGE_LABEL_KEYS);

/** Whether a stage label key is the framing stage. */
export function isFramingStage(key: string | null | undefined): boolean {
  return key === FRAMING_STAGE;
}

/**
 * A status as sent, with a stage label key the core schema does not list set to null, so it
 * still parses and the screen shows the label of the job's state.
 */
export function withKnownStage(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const key = (raw as { stageLabelKey?: unknown }).stageLabelKey;
  if (typeof key !== 'string' || CORE_STAGES.has(key)) return raw;
  return { ...raw, stageLabelKey: null };
}

/**
 * Reads a render status, tolerating a stage label key added by a newer server: an unknown key
 * becomes null.
 */
export const RenderStatusReader = {
  safeParse: (raw: unknown) => RenderStatusSchema.safeParse(withKnownStage(raw)),
};

/** Reads a `POST /v1/renders` answer, tolerating a stage label key added by a newer server. */
export const CreateRenderResponseReader = {
  safeParse: (raw: unknown) => CreateRenderResponseSchema.safeParse(withKnownStage(raw)),
};

/** Reads a project's variants list, tolerating a newer stage label key on its running job. */
export const VariantListResponseReader = {
  safeParse: (raw: unknown) => {
    const running =
      typeof raw === 'object' && raw !== null && 'activeRender' in raw
        ? (raw as { activeRender: unknown }).activeRender
        : undefined;
    return VariantListResponseSchema.safeParse(
      running === undefined ? raw : { ...(raw as object), activeRender: withKnownStage(running) },
    );
  },
};
