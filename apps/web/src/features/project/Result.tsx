import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { Project } from '@hailiday/core';
import { holidayName, sceneTypeLabel, t } from '../../copy';
import { makingLook, refuseWhileMakingLook, useProjectStore } from '../../state/projectStore';
import { Disclosure } from '../../ui/Disclosure';
import { useCardOnStage } from '../../ui/stringGeometry';
import { useReducedMotion } from '../../ui/motion';
import { TextWithLink } from '../../ui/TextWithLink';
import { SaveSheet } from '../account/SaveSheet';
import { ReportSheet } from '../report/ReportSheet';
import { ShareSheet } from '../share/ShareSheet';
import { ShopTheLook } from '../shop/ShopTheLook';
import { SceneChooser } from '../upload/SceneChooser';
import '../upload/upload.css';
import { changeSceneType, retryPendingLook } from './controller';
import { DeleteSheet } from './DeleteSheet';
import { Feedback } from './Feedback';
import { ProjectInlineError } from './InlineError';
import { LookControls, SelectedLookLabel } from './LookControls';
import { CancelLook, LOCK_HINT_ID, LookCard } from './LookProgress';
import { ResultActions, ResultMore, type ResultSheet } from './ResultActions';
import { ResultNotices } from './ResultNotices';
import { ProjectSourceStage } from './SourceImage';
import { useControlsBelowStage } from './stageLayout';
import { UnfinishedLook } from './UnfinishedLook';
import { VariantCard } from './VariantCard';
import './result.css';

/**
 * "Looks like a {sceneTypeLabel} · Change" for an uploaded photo. Choosing another type
 * re-attaches the photo with it and decorates the current look again, so it is locked while a
 * look is being made (an open chooser closes when a look starts).
 */
export function ResultSceneChip({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const busy = useProjectStore((state) => state.busy);
  const locked = useProjectStore(makingLook);
  if (locked && open) setOpen(false);
  if (project.activeSource?.kind !== 'upload' || !project.sceneType) return null;
  const value = { sceneType: project.sceneType, roomType: project.roomType };
  return (
    <div className="result__scene">
      <button
        type="button"
        className="scene-chip"
        aria-expanded={open}
        aria-disabled={busy || locked || undefined}
        aria-describedby={locked ? LOCK_HINT_ID : undefined}
        onClick={() => {
          if (refuseWhileMakingLook()) return;
          if (!busy) setOpen(!open);
        }}
      >
        {t('scene.chip', { sceneTypeLabel: sceneTypeLabel(project.sceneType, project.roomType) })}
      </button>
      {open && !locked ? (
        <SceneChooser
          value={value}
          required={false}
          onChoose={(choice) => {
            setOpen(false);
            void changeSceneType(choice);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Scrolls the page back to its top, where the picture and the status of the look being made are,
 * when the picture's stage starts above the viewport. Smooth unless motion is reduced.
 */
function showPicture(root: HTMLElement | null, still: boolean): void {
  if (!root || root.getBoundingClientRect().top >= 0) return;
  const page = root.ownerDocument.documentElement;
  if (typeof page.scrollIntoView !== 'function') return;
  page.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
}

/**
 * The result, picture first: the picture on a stage that fills the first viewport under the
 * header (the Before / AI preview switch in its upper right corner), then on paper one line with
 * the caption, the title and the action row, the notice of another look that could not be
 * finished and the notices that apply, then four collapsed rows the person opens when they want
 * them: "Try another look" (holiday, style, lighting and the allowance counter), "Shop the look",
 * "How does it look?" (feedback and report) and "More" (scene type, replace photo or change
 * address, delete). Errors and the allowance sheet still surface without opening anything. Nothing but the required labels shares the picture.
 * A look asked for from the rows below the picture brings the picture back into view, because
 * the status of the look being made is shown there.
 */
export function Result() {
  const location = useLocation();
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  const project = useProjectStore((state) => state.project);
  const variant = useProjectStore((state) => state.variant);
  const revealFor = useProjectStore((state) => state.revealFor);
  const pending = useProjectStore((state) => state.pending);
  const unfinished = useProjectStore((state) => state.pendingError);
  const [sheet, setSheet] = useState<ResultSheet | null>(null);
  const reducedMotion = useReducedMotion();
  const phone = useControlsBelowStage();
  const cardOnStage = useCardOnStage();
  const justSaved = Boolean((location.state as { saved?: boolean } | null)?.saved);

  useEffect(() => {
    if (!variant || focused.current) return;
    focused.current = true;
    headingRef.current?.focus({ preventScroll: true });
  }, [variant]);

  const making = pending !== null;
  const wasMaking = useRef(making);
  useEffect(() => {
    const started = making && !wasMaking.current;
    wasMaking.current = making;
    if (started) showPicture(rootRef.current, reducedMotion);
  }, [making, reducedMotion]);

  if (!project) return null;

  const heading = (
    <h1
      id="result-heading"
      ref={headingRef}
      tabIndex={-1}
      className="title-section project__heading result__heading"
    >
      {variant
        ? t('result.heading', { holiday: holidayName(variant.holidayId) })
        : t('result.headingNeutral')}
    </h1>
  );

  const actions = variant ? (
    <ResultActions project={project} variant={variant} onOpen={setSheet} />
  ) : null;

  const rail = (
    <div className="result__rail">
      {justSaved ? (
        <p className="message message--success" role="status">
          <TextWithLink text={t('save.done')} linkText={t('places.title')} to="/places" />
        </p>
      ) : null}
      <ProjectInlineError />
      {unfinished ? (
        <UnfinishedLook failed={unfinished} onTryAgain={() => retryPendingLook(unfinished)} />
      ) : null}
      {variant ? (
        <>
          <ResultNotices project={project} variant={variant} />
          <Disclosure
            label={t('result.controlsHeading')}
            summary={<SelectedLookLabel />}
            className="result__looks"
          >
            <LookControls />
          </Disclosure>
          <ShopTheLook variant={variant} project={project} className="result__shop" />
          <Disclosure label={t('result.feedbackHeading')} className="result__feedback">
            <Feedback key={variant.renderAssetId} renderAssetId={variant.renderAssetId} />
            <button type="button" className="link-button" onClick={() => setSheet('report')}>
              {t('result.report')}
            </button>
          </Disclosure>
          <Disclosure label={t('result.more')} className="result__more">
            <ResultMore
              project={project}
              variant={variant}
              sceneChip={<ResultSceneChip project={project} />}
              onOpen={setSheet}
            />
          </Disclosure>
        </>
      ) : null}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="result"
      data-pending={making || undefined}
      data-revealing={
        (!reducedMotion && variant && revealFor === variant.renderAssetId) || undefined
      }
    >
      <section className="result__main" aria-labelledby="result-heading">
        {variant ? (
          <VariantCard
            variant={variant}
            project={project}
            reveal={revealFor === variant.renderAssetId}
            pending={pending !== null}
            stringHoliday={pending?.look.holidayId ?? null}
            stageCard={pending && cardOnStage ? <LookCard placement="stage" /> : undefined}
            controlsStart={pending && !cardOnStage && phone ? <CancelLook /> : undefined}
            heading={heading}
            bar={pending && !cardOnStage ? <LookCard placement="band" cancel={!phone} /> : null}
            actions={actions}
          >
            {rail}
          </VariantCard>
        ) : (
          <ProjectSourceStage project={project}>
            <div className="picture-head">
              <div className="picture-head__title">{heading}</div>
            </div>
            {rail}
          </ProjectSourceStage>
        )}
      </section>
      {sheet === 'save' ? (
        <SaveSheet projectId={project.id} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'share' && variant ? (
        <ShareSheet project={project} variant={variant} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'delete' ? (
        <DeleteSheet projectId={project.id} onClose={() => setSheet(null)} />
      ) : null}
      {sheet === 'report' && variant ? (
        <ReportSheet
          target={{ kind: 'render', id: variant.renderJobId }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </div>
  );
}
