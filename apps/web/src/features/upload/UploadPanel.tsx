import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { Link } from 'react-router';
import type { NormalizedBox, PeopleResolutionInput, Project, UploadStatus } from '@holiday/core';
import {
  completeUpload,
  createUpload,
  getProject,
  getUploadStatus,
  putProjectSource,
} from '../../api/endpoints';
import { isApiError, type ApiError } from '../../api/errors';
import { formatResetTime, formatWait, presentError } from '../../api/present';
import { sceneTypeLabel, t, type CopyKey } from '../../copy';
import { CLIENT_DEFAULTS, DISPLAY_VALUES, formatBytes } from '../../config/values';
import { currentHolidayId, hasChosenHoliday, isOffSeason, useAppStore } from '../../state/appStore';
import { undecoratedUpload, useProjectStore } from '../../state/projectStore';
import { HolidayOptions } from '../../ui/HolidayPicker';
import { chooseHolidayExplicitly } from '../../ui/holidaySelection';
import { Icon } from '../../ui/Icon';
import { ImageCard } from '../../ui/ImageCard';
import { RetryAfterButton } from '../../ui/RetryAfterButton';
import { TextWithLink } from '../../ui/TextWithLink';
import { looksExhausted } from '../project/looks';
import { PeopleSheet } from './PeopleSheet';
import { SceneChooser, type SceneChoice } from './SceneChooser';
import { ACCEPT_ATTRIBUTE, browserPrepareDeps, prepareImage } from './prepare';
import { pollUploadStatus, postToStorage } from './transfer';
import { prepareFailureMessage, uploadOutcome } from './uploadState';
import './upload.css';

type Step =
  'pick' | 'preparing' | 'uploading' | 'screening' | 'held' | 'ready' | 'attaching' | 'declined';

interface PeoplePrompt {
  boxes: NormalizedBox[];
  suggestedCropBox: NormalizedBox | null;
  message: string | null;
}

/** An attach that waits for the visitor to choose a holiday (off-season). */
interface DeferredAttach {
  ready: UploadStatus;
  choice: SceneChoice | null;
  resolution: PeopleResolutionInput | null;
}

/**
 * "Try again" for a rate-limited step or one whose session could not start, enabled once the
 * server's wait has passed.
 */
interface RetryPrompt {
  id: number;
  retryAfterSeconds: number | null;
  run: () => void;
}

let retryPromptId = 0;

/** Messages that come with "Try again". */
const RETRY_MESSAGES: readonly CopyKey[] = [
  'error.RATE_LIMITED',
  'session.limited',
  'session.failed',
];

/** The wait before "Try again": the server's `Retry-After` when rate limited, otherwise none. */
function retryWait(error: ApiError): number | null {
  return error.code === 'RATE_LIMITED' ? error.retryAfterSeconds : 0;
}

function prefersTwoPickers(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

export interface UploadPanelProps {
  project: Project;
  onAttached: (project: Project) => void;
  /** Show the screen heading and subline (off when embedded under another heading). */
  showHeading?: boolean;
  /** Primary-styled pickers (the interim prompt uses the upload as its primary action). */
  primary?: boolean;
}

/**
 * The upload step: pickers (camera and library on phones, one picker and a drop zone on
 * desktop), photo tips, the age-and-rights checkbox, browser preparation, the direct upload
 * with byte progress, screening with every outcome, the people prompt and the scene-type chip.
 * Once the photo is attached the caller requests the render.
 */
export function UploadPanel({
  project,
  onAttached,
  showHeading = true,
  primary = true,
}: UploadPanelProps) {
  const ids = useId();
  const attestationId = `${ids}-attest`;
  const attested = useAppStore((state) => state.attested);
  const setAttested = useAppStore((state) => state.setAttested);
  const holidayId = useAppStore(currentHolidayId);
  const holidayNeeded = useAppStore((state) => isOffSeason(state) && !hasChosenHoliday(state));
  const uploadMaxBytes = useAppStore(
    (state) => state.experience?.clientConfig.uploadMaxBytes ?? CLIENT_DEFAULTS.uploadMaxBytes,
  );
  const pollUploadMs = useAppStore(
    (state) => state.experience?.clientConfig.pollUploadMs ?? CLIENT_DEFAULTS.pollUploadMs,
  );
  const allowance = useAppStore((state) => state.allowance);
  const attachedSource = useProjectStore(undecoratedUpload);

  const [twoPickers] = useState(prefersTwoPickers);
  const [step, setStep] = useState<Step>('pick');
  const [percent, setPercent] = useState(0);
  const [messages, setMessages] = useState<CopyKey[]>([]);
  const [attestationRequired, setAttestationRequired] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{
    url: string;
    width: number | null;
    height: number | null;
  } | null>(null);
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [scene, setScene] = useState<SceneChoice | null>(null);
  const [chooser, setChooser] = useState<'closed' | 'open' | 'required'>('closed');
  const [people, setPeople] = useState<PeoplePrompt | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [resolution, setResolution] = useState<PeopleResolutionInput | null>(null);
  const [dragging, setDragging] = useState(false);
  const [retryPrompt, setRetryPrompt] = useState<RetryPrompt | null>(null);

  const attestationRef = useRef<HTMLInputElement>(null);
  const declineRef = useRef<HTMLParagraphElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const projectRef = useRef(project);
  const previewUrlRef = useRef<string | null>(null);
  const deferredRef = useRef<DeferredAttach | null>(null);
  const resumeRef = useRef<(next: DeferredAttach) => void>(() => undefined);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    resumeRef.current = (next) => void attach(next.ready, next.choice, next.resolution);
  });

  // A ready photo that waited for a holiday continues on its own once one is chosen, from the
  // inline picker or the header chip.
  useEffect(
    () =>
      useAppStore.subscribe((state) => {
        const next = deferredRef.current;
        if (!next || (isOffSeason(state) && !hasChosenHoliday(state))) return;
        deferredRef.current = null;
        resumeRef.current(next);
      }),
    [],
  );

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    },
    [],
  );

  useEffect(() => {
    if (step === 'declined') declineRef.current?.focus();
  }, [step]);

  function showPreview(blob: Blob, width: number | null, height: number | null) {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const url = URL.createObjectURL(blob);
    previewUrlRef.current = url;
    setPreview({ url, width, height });
  }

  function reset() {
    abortRef.current?.abort();
    deferredRef.current = null;
    setRetryPrompt(null);
    setStep('pick');
    setPercent(0);
    setStatus(null);
    setScene(null);
    setChooser('closed');
    setPeople(null);
    setPeopleOpen(false);
    setResolution(null);
    setMessages([]);
  }

  /**
   * Attaches the ready photo as the project's source with the confirmed scene type and, when
   * people were detected, the chosen resolution. The caller then requests the render.
   */
  async function attach(
    ready: UploadStatus,
    choice: SceneChoice | null,
    resolution: PeopleResolutionInput | null,
    retried = false,
  ) {
    if (
      useAppStore.getState().experience &&
      isOffSeason(useAppStore.getState()) &&
      !hasChosenHoliday(useAppStore.getState())
    ) {
      deferredRef.current = { ready, choice, resolution };
      setStep('ready');
      return;
    }
    deferredRef.current = null;
    setStep('attaching');
    setMessages([]);
    setRetryPrompt(null);
    try {
      const updated = await putProjectSource(projectRef.current.id, {
        projectVersion: projectRef.current.projectVersion,
        sourceAssetId: ready.sourceAssetId,
        ...(choice
          ? {
              sceneType: choice.sceneType,
              roomType: choice.sceneType === 'interior' ? choice.roomType : null,
            }
          : {}),
        ...(resolution ? { peopleResolution: resolution } : {}),
      });
      setPeople(null);
      setPeopleOpen(false);
      // Back to the start: when the render cannot start (for example at the allowance limit)
      // the attached photo shows here with "Decorate this photo".
      setStep('pick');
      onAttached(updated);
    } catch (error) {
      setStep('ready');
      if (!isApiError(error)) {
        setMessages(['error.unknown']);
        return;
      }
      switch (error.code) {
        case 'PEOPLE_DETECTED': {
          const details = error.typedDetails('PEOPLE_DETECTED');
          setResolution(null);
          setPeople({
            boxes: details?.boxes ?? ready.people.boxes,
            suggestedCropBox: details?.suggestedCropBox ?? null,
            message: resolution ? t('error.PEOPLE_DETECTED') : null,
          });
          setPeopleOpen(true);
          return;
        }
        case 'VALIDATION_FAILED': {
          const reason = error.typedDetails('VALIDATION_FAILED')?.reason;
          if (reason === 'scene_type_required') {
            setChooser('required');
            return;
          }
          if (reason === 'image_too_small' && resolution?.action === 'crop') {
            setResolution(null);
            setPeople((current) =>
              current ? { ...current, message: t('upload.imageTooSmall') } : current,
            );
            setPeopleOpen(true);
            return;
          }
          setMessages(['error.VALIDATION_FAILED']);
          return;
        }
        case 'UPLOAD_DECLINED':
          setStep('declined');
          setMessages(['error.UPLOAD_DECLINED']);
          return;
        case 'STALE_PROJECT_VERSION':
          if (!retried) {
            const fresh = await getProject(projectRef.current.id).catch(() => null);
            if (fresh) {
              projectRef.current = fresh;
              await attach(ready, choice, resolution, true);
              return;
            }
          }
          break;
        default:
          break;
      }
      const inline = presentError(error);
      setMessages(inline ? [inline.key] : []);
      if (error.code === 'RATE_LIMITED' || error.session) {
        offerRetry(retryWait(error), () => void attach(ready, choice, resolution));
      }
    }
  }

  function offerRetry(retryAfterSeconds: number | null, run: () => void) {
    retryPromptId += 1;
    setRetryPrompt({ id: retryPromptId, retryAfterSeconds, run });
  }

  /** Decides what the ready photo still needs; attaches at once when nothing is needed. */
  function afterReady(ready: UploadStatus) {
    const outcome = uploadOutcome(ready);
    if (outcome.kind !== 'ready') return;
    const detected: SceneChoice | null = ready.sceneType
      ? { sceneType: ready.sceneType, roomType: ready.roomType }
      : null;
    setScene(detected);
    setStep('ready');
    if (outcome.needsSceneChoice) setChooser('required');
    if (outcome.peopleDetected) {
      setPeople({
        boxes: ready.people.boxes,
        suggestedCropBox: ready.people.suggestedCropBox,
        message: null,
      });
      setPeopleOpen(true);
      return;
    }
    if (!outcome.needsSceneChoice) void attach(ready, detected, null);
  }

  /** Continues once the remaining choices (people, scene type, holiday) are made. */
  function continueIfReady(
    choice: SceneChoice | null,
    nextResolution: PeopleResolutionInput | null,
  ) {
    if (!status || status.state !== 'ready') return;
    if (people && !nextResolution) {
      setPeopleOpen(true);
      return;
    }
    if (chooser === 'required' && !choice) return;
    void attach(status, choice, nextResolution);
  }

  async function processFile(file: File) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    deferredRef.current = null;
    setMessages([]);
    setRetryPrompt(null);
    setPeople(null);
    setPeopleOpen(false);
    setResolution(null);
    setChooser('closed');
    setStep('preparing');
    setPercent(0);

    const prepared = await prepareImage(file, browserPrepareDeps, { maxBytes: uploadMaxBytes });
    if (controller.signal.aborted) return;
    if (!prepared.ok) {
      setStep('pick');
      setMessages(prepareFailureMessage(prepared.reason));
      return;
    }
    showPreview(prepared.blob, prepared.width, prepared.height);

    try {
      const created = await createUpload(
        {
          projectId: projectRef.current.id,
          contentType: prepared.contentType,
          byteLength: prepared.blob.size,
          clientPrepared: prepared.clientPrepared,
          attestation: { accepted: true, attestationVersion: CLIENT_DEFAULTS.attestationVersion },
        },
        file.name,
      );
      if (controller.signal.aborted) return;
      setStep('uploading');
      await postToStorage(
        created.upload,
        prepared.blob,
        prepared.clientPrepared ? 'photo.jpg' : file.name,
        setPercent,
        controller.signal,
      );
      await completeUpload(created.sourceAssetId);
      if (controller.signal.aborted) return;
      setStep('screening');
      const final = await pollUploadStatus(
        (signal) => getUploadStatus(created.sourceAssetId, signal),
        pollUploadMs,
        (update) => {
          setStatus(update);
          setStep(update.state === 'screening' && update.holdForReview ? 'held' : 'screening');
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setStatus(final);
      const outcome = uploadOutcome(final);
      if (outcome.kind === 'ready') {
        afterReady(final);
      } else if (outcome.kind === 'declined') {
        setStep('declined');
        setMessages([outcome.messageKey]);
      } else {
        setStep('declined');
        setMessages(['upload.failed']);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setStep('pick');
      if (isApiError(error) && error.code === 'UPLOAD_DECLINED') {
        setStep('declined');
        setMessages(['error.UPLOAD_DECLINED']);
        return;
      }
      const inline = presentError(error);
      setMessages(inline ? [inline.key] : ['upload.failed']);
      if (isApiError(error) && (error.code === 'RATE_LIMITED' || error.session)) {
        offerRetry(retryWait(error), () => void processFile(file));
      }
    }
  }

  function onFileChosen(file: File | undefined) {
    if (!file) return;
    if (!attested) {
      setPendingFile(file);
      setAttestationRequired(true);
      attestationRef.current?.focus();
      return;
    }
    setPendingFile(null);
    void processFile(file);
  }

  function onAttestationChange(checked: boolean) {
    setAttested(checked);
    if (checked) {
      setAttestationRequired(false);
      if (pendingFile) {
        const file = pendingFile;
        setPendingFile(null);
        void processFile(file);
      }
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    onFileChosen(event.dataTransfer.files[0]);
  }

  const busy =
    step === 'preparing' || step === 'uploading' || step === 'screening' || step === 'attaching';
  const showPickers = step === 'pick' || step === 'declined';
  const looksUsedUp = looksExhausted(allowance);
  const resetsAt = formatResetTime(allowance?.variants.resetsAt ?? null);
  const showAttached = step === 'pick' && attachedSource !== null;
  const pickersPrimary = primary && !showAttached;
  const messageText = messages.map((key) =>
    t(key, {
      formats: DISPLAY_VALUES.formats,
      maxFileSize: formatBytes(uploadMaxBytes),
      holdWindow: DISPLAY_VALUES.holdWindow,
      retryAfter: formatWait(retryPrompt?.retryAfterSeconds ?? 60),
    }),
  );

  const statusText =
    step === 'preparing'
      ? t('upload.preparing')
      : step === 'uploading'
        ? t('upload.uploading', { percent })
        : step === 'screening'
          ? t('upload.screening')
          : step === 'held'
            ? t('upload.held', { holdWindow: DISPLAY_VALUES.holdWindow })
            : step === 'attaching'
              ? t('upload.screening')
              : '';
  // The live region names the stage only, so it speaks once per stage rather than per percent.
  const stageAnnouncement = step === 'uploading' ? t('upload.uploadingStage') : statusText;

  const pickerInput = (
    capture: boolean,
    label: string,
    icon: 'camera' | 'photo' | 'upload',
    isPrimary: boolean,
  ) => (
    <label
      className={`button picker${isPrimary && pickersPrimary ? ' button--primary' : ''} picker--block`}
    >
      <Icon name={icon} />
      <span>{label}</span>
      <input
        type="file"
        className="sr-only"
        accept={ACCEPT_ATTRIBUTE}
        {...(capture ? { capture: 'environment' as const } : {})}
        onChange={(event) => {
          onFileChosen(event.target.files?.[0]);
          event.target.value = '';
        }}
        disabled={busy}
      />
    </label>
  );

  return (
    <div className="upload stack">
      {showHeading ? (
        <header className="upload__header">
          <h1 className="title-section">{t('upload.heading')}</h1>
          <p className="lede">{t('upload.subline')}</p>
        </header>
      ) : null}

      {holidayNeeded ? (
        <div className="upload__holiday">
          <p id={`${ids}-holiday`} className="eyebrow">
            {t('upload.chooseHoliday')}
          </p>
          <HolidayOptions
            compact
            selected={holidayId}
            labelledBy={`${ids}-holiday`}
            onChoose={(id) => chooseHolidayExplicitly(id, 'landing')}
          />
        </div>
      ) : null}

      {showAttached && attachedSource ? (
        <div className="upload__preview upload__attached">
          {looksUsedUp ? (
            <p className="message message--notice">{t('allowance.bodyNoPreview', { resetsAt })}</p>
          ) : null}
          <ImageCard
            ratio={
              attachedSource.width && attachedSource.height
                ? attachedSource.width / attachedSource.height
                : 4 / 3
            }
            strip={<span>{t('result.yourPhoto')}</span>}
          >
            <img
              src={attachedSource.displayUrl ?? undefined}
              alt={
                project.sceneType
                  ? t('upload.previewAlt', {
                      sceneTypeLabel: sceneTypeLabel(project.sceneType, project.roomType),
                    })
                  : t('upload.previewAltPending')
              }
            />
          </ImageCard>
          <button
            type="button"
            className="button button--primary button--block"
            aria-disabled={holidayNeeded || undefined}
            aria-describedby={holidayNeeded ? `${ids}-decorate-reason` : undefined}
            onClick={() => {
              if (!holidayNeeded) onAttached(project);
            }}
          >
            {t('upload.continue')}
          </button>
          {holidayNeeded ? (
            <p id={`${ids}-decorate-reason`} className="fine">
              {t('upload.chooseHolidayFirst')}
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 'pick' && !showAttached && looksUsedUp ? (
        <p className="message message--notice">{t('allowance.uploadNotice', { resetsAt })}</p>
      ) : null}

      {preview && !showPickers ? (
        <div className="upload__preview">
          {step === 'ready' && scene && chooser !== 'required' ? (
            <button
              type="button"
              className="scene-chip"
              onClick={() => setChooser(chooser === 'open' ? 'closed' : 'open')}
            >
              {t('scene.chip', { sceneTypeLabel: sceneTypeLabel(scene.sceneType, scene.roomType) })}
            </button>
          ) : null}
          {chooser !== 'closed' && step === 'ready' ? (
            <SceneChooser
              value={scene}
              required={chooser === 'required'}
              onChoose={(choice) => {
                setScene(choice);
                setChooser('closed');
                continueIfReady(choice, resolution);
              }}
            />
          ) : null}
          <ImageCard
            ratio={preview.width && preview.height ? preview.width / preview.height : 4 / 3}
            strip={<span>{t('result.yourPhoto')}</span>}
          >
            <img
              src={preview.url}
              alt={
                scene
                  ? t('upload.previewAlt', {
                      sceneTypeLabel: sceneTypeLabel(scene.sceneType, scene.roomType),
                    })
                  : t('upload.previewAltPending')
              }
            />
          </ImageCard>
        </div>
      ) : null}

      <div className="upload__status">
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {stageAnnouncement}
        </p>
        {statusText ? (
          <div className="status-line" aria-hidden="true">
            <p className="upload__status-text">{statusText}</p>
            {step === 'uploading' ? (
              <div className="progress">
                <div className="progress__bar" style={{ width: `${percent}%` }} />
              </div>
            ) : (
              <div className="indeterminate" />
            )}
          </div>
        ) : null}
      </div>

      {step === 'held' ? (
        <button type="button" className="button button--quiet" onClick={reset}>
          {t('upload.tryAnother')}
        </button>
      ) : null}

      {messageText.length > 0 ? (
        <div className={step === 'declined' ? 'upload__declined' : undefined}>
          <p
            ref={declineRef}
            tabIndex={-1}
            className={step === 'declined' ? 'message message--notice' : 'message message--error'}
            role={step === 'declined' ? undefined : 'alert'}
          >
            {messageText.join(' ')}
            {step === 'declined' && messages.includes('error.UPLOAD_DECLINED') ? (
              <>
                {' '}
                <Link to="/content-policy">{t('footer.contentPolicy')}</Link>
              </>
            ) : null}
          </p>
          {retryPrompt && messages.some((key) => RETRY_MESSAGES.includes(key)) ? (
            <RetryAfterButton
              key={retryPrompt.id}
              retryAfterSeconds={retryPrompt.retryAfterSeconds}
              onRetry={retryPrompt.run}
            />
          ) : null}
        </div>
      ) : null}

      {step === 'ready' &&
      chooser !== 'required' &&
      (holidayNeeded || messages.length > 0 || (people && !resolution)) ? (
        <button
          type="button"
          className="button button--primary button--block"
          aria-disabled={holidayNeeded || undefined}
          aria-describedby={holidayNeeded ? `${ids}-holiday-reason` : undefined}
          onClick={() => {
            if (!holidayNeeded) continueIfReady(scene, resolution);
          }}
        >
          {t('upload.continue')}
        </button>
      ) : null}
      {step === 'ready' && holidayNeeded ? (
        <p id={`${ids}-holiday-reason`} className="fine">
          {t('upload.chooseHolidayFirst')}
        </p>
      ) : null}

      {showPickers ? (
        <>
          {step === 'declined' ? (
            <button type="button" className="button button--primary button--block" onClick={reset}>
              {t('upload.tryAnother')}
            </button>
          ) : twoPickers ? (
            <div className="upload__pickers">
              {pickerInput(true, t('upload.takePhoto'), 'camera', true)}
              {pickerInput(false, t('upload.chooseLibrary'), 'photo', false)}
            </div>
          ) : (
            <div
              className="dropzone"
              data-dragging={dragging || undefined}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              {pickerInput(false, t('upload.choosePhoto'), 'upload', true)}
              <p className="dropzone__hint">{t('upload.dropHint')}</p>
            </div>
          )}

          <details className="tips">
            <summary>{t('upload.tipsToggle')}</summary>
            <ul>
              <li>{t('upload.tip1')}</li>
              <li>{t('upload.tip2')}</li>
              <li>{t('upload.tip3')}</li>
            </ul>
          </details>

          <div className="attest">
            <label className="check" htmlFor={attestationId}>
              <input
                ref={attestationRef}
                id={attestationId}
                type="checkbox"
                checked={attested}
                aria-describedby={attestationRequired ? `${attestationId}-required` : undefined}
                aria-invalid={attestationRequired || undefined}
                onChange={(event) => onAttestationChange(event.target.checked)}
              />
              <span className="check__text">
                <TextWithLink
                  text={t('upload.attestation')}
                  linkText={t('footer.terms')}
                  to="/terms"
                />
              </span>
            </label>
            {attestationRequired ? (
              <p id={`${attestationId}-required`} className="field__error" role="alert">
                {t('upload.attestationRequired')}
              </p>
            ) : null}
          </div>
          <p className="fine">
            {t('upload.retentionLine', { anonymousRetention: DISPLAY_VALUES.anonymousRetention })}
          </p>
        </>
      ) : null}

      {people && peopleOpen && preview ? (
        <PeopleSheet
          imageUrl={preview.url}
          width={status?.width ?? preview.width}
          height={status?.height ?? preview.height}
          boxes={people.boxes}
          suggestedCropBox={people.suggestedCropBox}
          message={people.message}
          onCrop={(box, rotation) => {
            const next: PeopleResolutionInput = {
              action: 'crop',
              box,
              ...(rotation !== 0 ? { rotation } : {}),
            };
            setResolution(next);
            setPeopleOpen(false);
            continueIfReady(scene, next);
          }}
          onKeep={() => {
            const next: PeopleResolutionInput = { action: 'keep' };
            setResolution(next);
            setPeopleOpen(false);
            continueIfReady(scene, next);
          }}
          onReplace={reset}
          onClose={() => setPeopleOpen(false)}
        />
      ) : null}
    </div>
  );
}
