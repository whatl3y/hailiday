import { useState } from 'react';
import type { Example, HolidayId } from '@hailiday/core';
import { holidayName, sceneTypeLabel, t, tDynamic } from '../copy';
import { useAppStore } from '../state/appStore';
import { aiBadgeCorner } from './badgeCorner';
import { AiPreviewBadge, ImageCard } from './ImageCard';
import { useIsFixtureImage } from './fixture';

/** Example art is never a Street View frame, so its badge keeps the lower-right corner. */
const EXAMPLE_CORNER = aiBadgeCorner(false);

/** Examples with the current holiday (and scene type, when known) first. */
function orderExamples(
  examples: readonly Example[],
  holidayId: HolidayId | null,
  sceneType?: Example['sceneType'] | null,
): Example[] {
  const score = (example: Example) =>
    (example.holidayId === holidayId ? 0 : 2) +
    (sceneType && example.sceneType === sceneType ? 0 : 1);
  return [...examples].sort((a, b) => score(a) - score(b));
}

function ExampleCard({ example }: { example: Example }) {
  const [showBefore, setShowBefore] = useState(false);
  const fixture = useIsFixtureImage('example_after');
  const names = {
    holiday: holidayName(example.holidayId),
    sceneTypeLabel: sceneTypeLabel(example.sceneType),
  };
  const caption = tDynamic(example.captionKey, 'common.exampleLabel', names);
  // The image description follows the state shown; the caption and the toggle name differ.
  const alt = t(showBefore ? 'example.beforeAlt' : 'example.afterAlt', names);
  return (
    <div className="example-card">
      <ImageCard
        ratio={example.width / example.height}
        fixture={fixture && !showBefore}
        topEnd={<span className="badge badge--example">{t('common.exampleLabel')}</span>}
        corner={showBefore ? null : <AiPreviewBadge />}
        cornerPlacement={EXAMPLE_CORNER}
        strip={
          <>
            <span>{caption}</span>
            <span
              className="segmented segmented--small"
              role="group"
              aria-label={t('result.compareLabel')}
            >
              <button type="button" aria-pressed={showBefore} onClick={() => setShowBefore(true)}>
                {t('result.before')}
              </button>
              <button type="button" aria-pressed={!showBefore} onClick={() => setShowBefore(false)}>
                {t('result.aiPreview')}
              </button>
            </span>
          </>
        }
      >
        <img
          src={showBefore ? example.beforeUrl : example.afterUrl}
          alt={alt}
          loading="lazy"
          decoding="async"
          width={example.width}
          height={example.height}
        />
      </ImageCard>
    </div>
  );
}

/** A strip or grid of permissioned before-and-after examples, each labeled "Example". */
export function ExampleGallery({
  holidayId,
  sceneType,
  limit,
}: {
  holidayId: HolidayId | null;
  sceneType?: Example['sceneType'] | null;
  limit?: number;
}) {
  const examples = useAppStore((state) => state.experience?.examples ?? []);
  const ordered = orderExamples(examples, holidayId, sceneType).slice(0, limit);
  if (ordered.length === 0) return null;
  return (
    <div className="example-gallery">
      {ordered.map((example) => (
        <ExampleCard
          key={`${example.holidayId}.${example.sceneType}.${example.style}.${example.lightingMode}`}
          example={example}
        />
      ))}
    </div>
  );
}
