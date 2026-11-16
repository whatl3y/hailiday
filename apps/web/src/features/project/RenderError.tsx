import { useEffect, useRef } from 'react';
import { holidayName, t } from '../../copy';
import { useProjectStore } from '../../state/projectStore';
import { retryRender } from './controller';
import { ProjectInlineError } from './InlineError';
import { ProjectSourceStage } from './SourceImage';
import { UnfinishedLook } from './UnfinishedLook';
import { VariantCard } from './VariantCard';

/**
 * A first look that ended with nothing to show: the picture keeps its stage (the place's photo,
 * or a look on screen), and under it on paper one notice says what happened and what the person
 * can do next, after the inline message of a request the server refused (as "Try again" can be).
 */
export function RenderError() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const project = useProjectStore((state) => state.project);
  const render = useProjectStore((state) => state.render);
  const variant = useProjectStore((state) => state.variant);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  if (!project || !render) return null;

  const heading = (
    <h1
      id="render-error-heading"
      ref={headingRef}
      tabIndex={-1}
      className="title-section project__heading result__heading"
    >
      {variant
        ? t('result.heading', { holiday: holidayName(variant.holidayId) })
        : t('pageTitle.project')}
    </h1>
  );

  const body = (
    <div className="result__rail render-error__body">
      <ProjectInlineError />
      <UnfinishedLook failed={render} onTryAgain={retryRender} />
    </div>
  );

  return (
    <section className="render-error" aria-labelledby="render-error-heading">
      {variant ? (
        <VariantCard variant={variant} project={project} heading={heading}>
          {body}
        </VariantCard>
      ) : (
        <ProjectSourceStage project={project}>
          <div className="picture-head">
            <div className="picture-head__title">{heading}</div>
          </div>
          {body}
        </ProjectSourceStage>
      )}
    </section>
  );
}
