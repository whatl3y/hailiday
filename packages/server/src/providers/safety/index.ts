import type {
  NormalizedBox,
  QualityHint,
  UploadGuidanceReason,
  UploadTriage,
} from '@hailiday/core';
import { screeningTriggerFor, triggerPeopleBoxes } from '../../fixtures/data.js';
import { ProviderConfigError, isProviderError } from '../errors.js';
import type {
  CallOptions,
  ImageInput,
  SafetyProvider,
  ScreenUploadInput,
  ScreeningResult,
  UploadTriageCall,
  VisionModel,
} from '../types.js';

/** Content-screening vendor operations (hash matching, moderation, people detection). */
export interface ContentScreener {
  readonly providerId: string;
  readonly mode: 'fixture' | 'live';
  hashMatch(image: ImageInput, input: ScreenUploadInput): Promise<{ matched: boolean }>;
  moderate(
    image: ImageInput,
    input: ScreenUploadInput,
  ): Promise<{
    outcome: 'clean' | 'review' | 'decline';
    categories: string[];
    childSafety: boolean;
  }>;
  detectPeople(
    image: ImageInput,
    input: ScreenUploadInput,
    triage: UploadTriage | null,
  ): Promise<{ boxes: NormalizedBox[]; suggestedCropBox?: NormalizedBox | null }>;
}

/**
 * The largest axis-aligned crop that excludes every people box expanded by a margin (4% of the
 * long edge) and keeps a short edge of at least `minShortEdge` pixels; null when none exists.
 */
export function suggestCropBox(
  boxes: readonly NormalizedBox[],
  image: { width: number; height: number },
  options: { marginFraction?: number; minShortEdge?: number } = {},
): NormalizedBox | null {
  if (boxes.length === 0) return null;
  const long = Math.max(image.width, image.height);
  const mx = ((options.marginFraction ?? 0.04) * long) / image.width;
  const my = ((options.marginFraction ?? 0.04) * long) / image.height;
  const expanded = boxes.map(
    ([x0, y0, x1, y1]) =>
      [
        Math.max(0, x0 - mx),
        Math.max(0, y0 - my),
        Math.min(1, x1 + mx),
        Math.min(1, y1 + my),
      ] as const,
  );
  const xs = [...new Set([0, 1, ...expanded.flatMap(([x0, , x1]) => [x0, x1])])].sort(
    (a, b) => a - b,
  );
  const ys = [...new Set([0, 1, ...expanded.flatMap(([, y0, , y1]) => [y0, y1])])].sort(
    (a, b) => a - b,
  );
  const minShort = options.minShortEdge ?? 640;
  let best: NormalizedBox | null = null;
  let bestArea = 0;
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      for (let k = 0; k < ys.length; k += 1) {
        for (let l = k + 1; l < ys.length; l += 1) {
          const box: NormalizedBox = [
            xs[i] as number,
            ys[k] as number,
            xs[j] as number,
            ys[l] as number,
          ];
          const overlaps = expanded.some(
            ([x0, y0, x1, y1]) => box[0] < x1 && box[2] > x0 && box[1] < y1 && box[3] > y0,
          );
          if (overlaps) continue;
          const wPx = (box[2] - box[0]) * image.width;
          const hPx = (box[3] - box[1]) * image.height;
          if (Math.min(wPx, hPx) < minShort) continue;
          const area = wPx * hPx;
          if (area > bestArea) {
            bestArea = area;
            best = box;
          }
        }
      }
    }
  }
  return best;
}

const SUBJECT_DECLINE: Partial<Record<UploadTriage['subjectClass'], UploadGuidanceReason>> = {
  people: 'subject_is_people',
  document_or_screen: 'document_or_screen',
  other: 'not_a_living_space',
};

/**
 * Content admission in order: hash matching and moderation before any paid vision call, then
 * the living-space and scene check (triage: the input's `triage` call when given, else this
 * pipeline's vision model), then people detection on admitted images. A triage refusal holds the
 * upload for review.
 */
export function createScreeningPipeline(parts: {
  screener: ContentScreener;
  vision: VisionModel;
}): SafetyProvider {
  return {
    providerId: parts.screener.providerId,
    mode: parts.screener.mode,
    async screenUpload(
      input: ScreenUploadInput,
      callOptions?: CallOptions,
    ): Promise<ScreeningResult> {
      const base: ScreeningResult = {
        outcome: 'admitted',
        reasonClass: null,
        reason: null,
        childSafety: false,
        triage: null,
        peopleDetected: false,
        peopleBoxes: [],
        suggestedCropBox: null,
        qualityHints: [],
        checks: [],
        providerMode: parts.screener.mode,
        usage: { visionCalls: 0, moderationCalls: 0 },
      };
      const hash = await parts.screener.hashMatch(input.image, input);
      base.checks.push({ check: 'hash_match', outcome: hash.matched ? 'flag' : 'pass' });
      if (hash.matched) {
        return {
          ...base,
          outcome: 'declined',
          reasonClass: 'safety',
          reason: 'hash_match',
          childSafety: true,
        };
      }
      const moderation = await parts.screener.moderate(input.image, input);
      base.usage.moderationCalls += 1;
      base.checks.push({
        check: 'moderation',
        outcome: moderation.outcome === 'clean' ? 'pass' : 'flag',
      });
      if (moderation.childSafety) {
        return {
          ...base,
          outcome: 'declined',
          reasonClass: 'safety',
          reason: 'child_safety',
          childSafety: true,
        };
      }
      if (moderation.outcome === 'decline')
        return { ...base, outcome: 'declined', reasonClass: 'safety', reason: 'classifier' };
      if (moderation.outcome === 'review') return { ...base, outcome: 'held' };

      const triageInput = {
        image: input.image,
        ...(input.fixture ? { fixture: input.fixture } : {}),
      };
      let call: Awaited<ReturnType<UploadTriageCall>>;
      try {
        call = input.triage
          ? await input.triage(triageInput, callOptions)
          : await parts.vision.classifyUpload(triageInput, callOptions);
      } catch (error) {
        // A vision model that refuses to look at the image is a safety signal: a person reviews it.
        if (isProviderError(error) && error.kind === 'moderation_blocked') {
          base.usage.visionCalls += 1;
          base.checks.push({ check: 'living_space', outcome: 'flag' });
          return { ...base, outcome: 'held' };
        }
        throw error;
      }
      const triage = call.result;
      base.usage.visionCalls += 1;
      base.triage = triage;
      base.triageCall = {
        providerId: call.providerId ?? parts.vision.providerId,
        providerMode: call.providerMode,
        model: call.model,
        promptVersion: call.promptVersion,
        usage: call.usage,
        elapsedMs: call.elapsedMs,
      };
      base.qualityHints = [...new Set(triage.qualityFlags)] as QualityHint[];
      const subjectReason = SUBJECT_DECLINE[triage.subjectClass];
      if (subjectReason || triage.multiUnitFacade) {
        base.checks.push({ check: 'living_space', outcome: 'flag' });
        return {
          ...base,
          outcome: 'declined',
          reasonClass: 'guidance',
          reason: subjectReason ?? 'multi_unit_facade',
        };
      }
      base.checks.push({ check: 'living_space', outcome: 'pass' });

      const people = await parts.screener.detectPeople(input.image, input, triage);
      base.checks.push({
        check: 'people_detection',
        outcome: people.boxes.length > 0 ? 'flag' : 'pass',
      });
      return {
        ...base,
        peopleDetected: people.boxes.length > 0,
        peopleBoxes: people.boxes,
        suggestedCropBox:
          people.boxes.length === 0
            ? null
            : people.suggestedCropBox !== undefined
              ? people.suggestedCropBox
              : suggestCropBox(people.boxes, input.image),
      };
    },
  };
}

/**
 * Fixture screener: never calls a vendor. File-name triggers decide the outcome: `decline` is
 * declined by the living-space check, `people` admits with people boxes, `hold` is held by the
 * moderation step; everything else is admitted.
 */
export function createFixtureScreener(): ContentScreener {
  return {
    providerId: 'fixture-safety',
    mode: 'fixture',
    async hashMatch() {
      return { matched: false };
    },
    async moderate(_image, input) {
      const trigger = screeningTriggerFor(input.fixture?.fileName);
      return {
        outcome: trigger?.outcome === 'held' ? 'review' : 'clean',
        categories: [],
        childSafety: false,
      };
    },
    async detectPeople(_image, input, triage) {
      const trigger = screeningTriggerFor(input.fixture?.fileName);
      const boxes = triggerPeopleBoxes(trigger);
      if (boxes.length > 0)
        return {
          boxes,
          suggestedCropBox: (trigger?.suggestedCropBox as NormalizedBox | undefined) ?? null,
        };
      return { boxes: triage?.peopleBoxes ?? [] };
    },
  };
}

export function createFixtureSafetyProvider(vision: VisionModel): SafetyProvider {
  return createScreeningPipeline({ screener: createFixtureScreener(), vision });
}

/** No live screening vendor is selected yet; selecting one is a configuration error. */
export function createLiveSafetyProvider(): SafetyProvider {
  throw new ProviderConfigError(
    'safety',
    'No live content-screening vendor is configured; SAFETY_PROVIDER must be fixture until a vendor is selected',
  );
}
