import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { Project } from '@holiday/core';
import { holidayName, sceneTypeLabel, t } from '../../copy';
import { useProjectStore } from '../../state/projectStore';
import { useReducedMotion } from '../../ui/motion';
import { TextWithLink } from '../../ui/TextWithLink';
import { SaveSheet } from '../account/SaveSheet';
import { ReportSheet } from '../report/ReportSheet';
import { ShareSheet } from '../share/ShareSheet';
import { ShopTheLook } from '../shop/ShopTheLook';
import { SceneChooser } from '../upload/SceneChooser';
import '../upload/upload.css';
import { changeSceneType } from './controller';
import { DeleteSheet } from './DeleteSheet';
import { Feedback } from './Feedback';
import { ProjectInlineError } from './InlineError';
import { LookControls } from './LookControls';
import { PendingBand, PendingErrorSheet } from './PendingLook';
import { ResultActions, type ResultSheet } from './ResultActions';
import { ResultNotices } from './ResultNotices';
import { ProjectSourceCard } from './SourceImage';
import { VariantCard } from './VariantCard';
import './result.css';

/**
 * "Looks like a {sceneTypeLabel} · Change" for an uploaded photo. Choosing another type
 * re-attaches the photo with it and decorates the current look again.
 */
export function ResultSceneChip({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const busy = useProjectStore((state) => state.busy);
  if (project.activeSource?.kind !== 'upload' || !project.sceneType) return null;
  const value = { sceneType: project.sceneType, roomType: project.roomType };
  return (
    <div className="result__scene">
      <button
        type="button"
        className="scene-chip"
        aria-expanded={open}
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) setOpen(!open);
        }}
      >
        {t('scene.chip', { sceneTypeLabel: sceneTypeLabel(project.sceneType, project.roomType) })}
      </button>
      {open ? (
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
 * The result: the reveal of the decorated place, then everything else beneath it. On phones
 * the order is holiday, style, lighting, counter, actions, notices, feedback and Shop the look;
 * on wide screens the controls, actions and notices form a rail beside the card and Shop the
 * look spans the full width beneath. Nothing but the required labels shares the card.
 */
export function Result() {
  const location = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focused = useRef(false);
  const project = useProjectStore((state) => state.project);
  const variant = useProjectStore((state) => state.variant);
  const revealFor = useProjectStore((state) => state.revealFor);
  const pending = useProjectStore((state) => state.pending);
  const [sheet, setSheet] = useState<ResultSheet | null>(null);
  const reducedMotion = useReducedMotion();
  const justSaved = Boolean((location.state as { saved?: boolean } | null)?.saved);

  useEffect(() => {
    if (!variant || focused.current) return;
    focused.current = true;
    headingRef.current?.focus({ preventScroll: true });
  }, [variant]);

  if (!project) return null;

  return (
    <div
      className="result"
      data-revealing={
        (!reducedMotion && variant && revealFor === variant.renderAssetId) || undefined
      }
    >
      <section className="project-grid result__grid" aria-labelledby="result-heading">
        <div className="project-grid__media">
          <div className="result__card" data-pending={pending ? true : undefined}>
            {variant ? (
              <VariantCard
                variant={variant}
                project={project}
                reveal={revealFor === variant.renderAssetId}
                bar={<PendingBand />}
              />
            ) : (
              <ProjectSourceCard project={project} />
            )}
          </div>
        </div>
        <div className="project-grid__side result__rail">
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
          {justSaved ? (
            <p className="message message--success" role="status">
              <TextWithLink text={t('save.done')} linkText={t('places.title')} to="/places" />
            </p>
          ) : null}
          {variant ? <ResultSceneChip project={project} /> : null}
          <ProjectInlineError />
          {variant ? (
            <>
              <LookControls />
              <ResultActions project={project} variant={variant} onOpen={setSheet} />
              <ResultNotices project={project} variant={variant} />
              <div className="result__feedback">
                <Feedback key={variant.renderAssetId} renderAssetId={variant.renderAssetId} />
                <button type="button" className="link-button" onClick={() => setSheet('report')}>
                  {t('result.report')}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </section>
      {variant ? (
        <div className="result__shop">
          <ShopTheLook variant={variant} project={project} />
        </div>
      ) : null}
      <PendingErrorSheet />
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
