import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { NUDGE_HEADING_MAX_DEGREES, NUDGE_HEADING_STEP_DEGREES } from '@holiday/core';
import { t } from '../../copy';
import { currentHolidayId, hasChosenHoliday, isOffSeason, useAppStore } from '../../state/appStore';
import {
  baseCandidateOf,
  selectedCandidate,
  useProjectStore,
  type ProjectFlowState,
} from '../../state/projectStore';
import { isOldCapture } from '../../ui/captureDate';
import { HolidayOptions } from '../../ui/HolidayPicker';
import { chooseHolidayExplicitly } from '../../ui/holidaySelection';
import { Icon } from '../../ui/Icon';
import { UploadPanel } from '../upload/UploadPanel';
import { confirmPlace, nudge, onUploadAttached, selectView, showUpload } from './controller';
import { ProjectInlineError } from './InlineError';
import { StreetViewCard } from './SourceImage';

function canNudgeIn(state: ProjectFlowState, direction: -1 | 1): boolean {
  const base = baseCandidateOf(state, state.selectedCandidateId);
  if (!base) return false;
  const offset = (state.nudgeOffsets[base] ?? 0) + direction * NUDGE_HEADING_STEP_DEGREES;
  return Math.abs(offset) <= NUDGE_HEADING_MAX_DEGREES;
}

/**
 * "Is this the right place?": the primary candidate image with its attribution strip, up to
 * three views and bounded nudges within the display budget, and one primary action. In
 * display-only mode the same screen becomes the interim photo prompt.
 */
export function ConfirmPlace() {
  const navigate = useNavigate();
  const headingId = useId();
  const pickerId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const flow = useProjectStore();
  const holidayId = useAppStore(currentHolidayId);
  const needsHoliday = useAppStore((state) => isOffSeason(state) && !hasChosenHoliday(state));
  const hasExamples = useAppStore((state) => (state.experience?.examples.length ?? 0) > 0);
  const openSheet = useAppStore((state) => state.openSheet);
  const [now] = useState(() => new Date());

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const candidate = selectedCandidate(flow);
  const project = flow.project;
  if (!project || !candidate) return null;

  const interim = flow.discovery?.sourceMode === 'display_only';
  const budgetSpent = flow.remainingDisplayLoads <= 0;
  const selectedBase = baseCandidateOf(flow, flow.selectedCandidateId);
  const address = flow.displayAddress ?? project.property?.formattedAddress ?? null;

  return (
    <section className="project-grid" aria-labelledby={headingId}>
      <div className="project-grid__media">
        <StreetViewCard
          candidate={candidate}
          logo={flow.discovery?.attribution?.logo ?? 'google_maps'}
          loading={flow.busy}
        />
        {isOldCapture(candidate.captureDate, now) ? (
          <button
            type="button"
            className="link-button project__old-capture"
            onClick={() => showUpload('none_of_these')}
          >
            {t('confirm.oldCapture')}
          </button>
        ) : null}
      </div>

      <div className="project-grid__side stack">
        {flow.confirmNotice === 'viewChanged' ? (
          <p className="message message--notice">{t('confirm.viewChanged')}</p>
        ) : null}
        <div className="stack stack--tight">
          <h1
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="title-section project__heading"
          >
            {t('confirm.heading')}
          </h1>
          {address ? <p className="project__address">{address}</p> : null}
        </div>

        {interim ? (
          <p className="lede">{t('interim.explain')}</p>
        ) : (
          <div className="views">
            {flow.baseCandidateIds.length > 1 ? (
              <div className="views__list" role="group" aria-label={t('confirm.views')}>
                {flow.baseCandidateIds.map((id, index) => {
                  const item = flow.candidates.find((entry) => entry.candidateId === id);
                  const unavailable = !item?.displayUrl && budgetSpent;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="view-chip"
                      aria-pressed={selectedBase === id}
                      aria-disabled={unavailable || undefined}
                      onClick={() => {
                        if (!unavailable) void selectView(id);
                      }}
                    >
                      {item?.displayUrl ? (
                        <img src={item.displayUrl} alt="" className="view-chip__thumb" />
                      ) : null}
                      {t('confirm.viewN', { n: index + 1 })}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {!budgetSpent ? (
              <div className="views__nudges">
                {canNudgeIn(flow, -1) ? (
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => void nudge(-1)}
                  >
                    <Icon name="rotateLeft" />
                    {t('confirm.lookLeft')}
                  </button>
                ) : null}
                {canNudgeIn(flow, 1) ? (
                  <button
                    type="button"
                    className="button button--small"
                    onClick={() => void nudge(1)}
                  >
                    {t('confirm.lookRight')}
                    <Icon name="rotateRight" />
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="fine">{t('confirm.noMoreViews')}</p>
            )}
          </div>
        )}

        {!interim && needsHoliday ? (
          <div className="project__holiday">
            <p id={pickerId} className="eyebrow">
              {t('confirm.chooseHolidayFirst')}
            </p>
            <HolidayOptions
              compact
              selected={holidayId}
              labelledBy={pickerId}
              onChoose={(id) => chooseHolidayExplicitly(id, 'result')}
            />
          </div>
        ) : null}

        <ProjectInlineError />

        {interim ? (
          <div className="stack">
            <UploadPanel
              project={project}
              showHeading={false}
              onAttached={(next) => void onUploadAttached(next)}
            />
            <p className="fine">{t('interim.noPhoto')}</p>
            <div className="row">
              <button
                type="button"
                className="link-button"
                onClick={() => navigate('/', { state: { focusAddress: true } })}
              >
                {t('interim.changeAddress')}
              </button>
              {hasExamples ? (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => openSheet({ kind: 'examples' })}
                >
                  {t('landing.seeExample')}
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="project__actions">
            <button
              type="button"
              className="button button--primary button--block"
              aria-disabled={needsHoliday || flow.busy || undefined}
              aria-describedby={needsHoliday ? `${pickerId}-reason` : undefined}
              onClick={() => {
                if (!needsHoliday && !flow.busy) void confirmPlace();
              }}
            >
              {t('confirm.yes')}
            </button>
            {needsHoliday ? (
              <p id={`${pickerId}-reason`} className="fine">
                {t('confirm.chooseHolidayReason')}
              </p>
            ) : null}
            <button
              type="button"
              className="button button--quiet"
              onClick={() => showUpload('none_of_these')}
            >
              {t('confirm.none')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
