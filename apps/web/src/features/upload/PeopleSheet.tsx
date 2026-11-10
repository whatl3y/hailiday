import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { straightenScale, type NormalizedBox } from '@holiday/core';
import { t } from '../../copy';
import { CLIENT_DEFAULTS } from '../../config/values';
import { Sheet } from '../../ui/Sheet';
import {
  CORNERS,
  cornerPoint,
  fitMinimumSpan,
  minimumCropSpan,
  moveCorner,
  straightenedSize,
  type Corner,
} from './crop';
import { StraightenSlider } from './StraightenSlider';

const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.05;

function boxStyle([x0, y0, x1, y1]: NormalizedBox) {
  return {
    left: `${x0 * 100}%`,
    top: `${y0 * 100}%`,
    width: `${(x1 - x0) * 100}%`,
    height: `${(y1 - y0) * 100}%`,
  };
}

function CropTool({
  imageUrl,
  ratio,
  box,
  rotation,
  scale,
  onChange,
  minSpan,
}: {
  imageUrl: string;
  ratio: number;
  box: NormalizedBox;
  /** Straighten angle in degrees, clockwise positive. */
  rotation: number;
  /** The zoom that keeps the turned photo filling the frame. */
  scale: number;
  onChange: (box: NormalizedBox) => void;
  minSpan: { x: number; y: number };
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<Corner | null>(null);

  function pointFromEvent(event: PointerEvent) {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }

  function onKeyDown(corner: Corner, event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const point = cornerPoint(box, corner);
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const delta = moves[event.key];
    if (!delta) return;
    event.preventDefault();
    onChange(moveCorner(box, corner, point.x + delta[0], point.y + delta[1], minSpan));
  }

  return (
    <div
      className="crop"
      style={{ aspectRatio: String(ratio), '--ratio': String(ratio) } as CSSProperties}
      ref={frameRef}
    >
      <img
        src={imageUrl}
        alt=""
        className="crop__image"
        draggable={false}
        style={rotation === 0 ? undefined : { transform: `rotate(${rotation}deg) scale(${scale})` }}
      />
      <div
        className="crop__frame"
        style={boxStyle(box)}
        role="group"
        aria-label={t('upload.cropFrame')}
      >
        {CORNERS.map((corner) => (
          <button
            key={corner}
            type="button"
            className={`crop__handle crop__handle--${corner}`}
            aria-label={t('upload.cropCorner', { corner: t(`upload.corner.${corner}`) })}
            onKeyDown={(event) => onKeyDown(corner, event)}
            onPointerDown={(event) => {
              dragging.current = corner;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (dragging.current !== corner) return;
              const point = pointFromEvent(event);
              if (point) onChange(moveCorner(box, corner, point.x, point.y, minSpan));
            }}
            onPointerUp={() => {
              dragging.current = null;
            }}
          />
        ))}
      </div>
    </div>
  );
}

export interface PeopleSheetProps {
  imageUrl: string;
  width: number | null;
  height: number | null;
  boxes: NormalizedBox[];
  suggestedCropBox: NormalizedBox | null;
  /** The frame on the straightened view and the straighten angle (degrees, clockwise). */
  onCrop: (box: NormalizedBox, rotation: number) => void;
  onKeep: () => void;
  onReplace: () => void;
  onClose: () => void;
  message?: string | null;
}

/**
 * The people prompt: the photo with soft highlights over the detected regions (no labels,
 * counts or identity text), "Crop them out" with a frame that starts on the suggested crop (or
 * the whole photo when the detector could not suggest one) and a straighten control that turns
 * the photo up to 15° either way (zoomed to leave no empty corners, as the server crops it), and
 * "Keep as is", which keeps the preview private.
 */
export function PeopleSheet({
  imageUrl,
  width,
  height,
  boxes,
  suggestedCropBox,
  onCrop,
  onKeep,
  onReplace,
  onClose,
  message,
}: PeopleSheetProps) {
  const [cropping, setCropping] = useState(false);
  const [box, setBox] = useState<NormalizedBox>(suggestedCropBox ?? [0, 0, 1, 1]);
  const [rotation, setRotation] = useState(0);
  const ratio = width && height ? width / height : 4 / 3;
  const scale = width && height ? straightenScale(rotation, width, height) : 1;
  const straightened = straightenedSize(width, height, rotation);
  const minSpan = minimumCropSpan(
    straightened.width,
    straightened.height,
    CLIENT_DEFAULTS.minShortEdgePx,
  );

  function straighten(next: number) {
    setRotation(next);
    const size = straightenedSize(width, height, next);
    setBox((current) =>
      fitMinimumSpan(
        current,
        minimumCropSpan(size.width, size.height, CLIENT_DEFAULTS.minShortEdgePx),
      ),
    );
  }

  return (
    <Sheet
      title={cropping ? t('upload.cropHeading') : t('upload.peopleHeading')}
      onClose={onClose}
      wide
    >
      {cropping ? (
        <>
          <p className="fine">{t('upload.cropHint')}</p>
          <CropTool
            imageUrl={imageUrl}
            ratio={ratio}
            box={box}
            rotation={rotation}
            scale={scale}
            onChange={setBox}
            minSpan={minSpan}
          />
          <StraightenSlider value={rotation} onChange={straighten} />
          {message ? (
            <p className="message message--error" role="alert">
              {message}
            </p>
          ) : null}
          <div className="row">
            <button
              type="button"
              className="button button--primary"
              onClick={() => onCrop(box, rotation)}
            >
              {t('upload.useCrop')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setCropping(false)}
            >
              {t('common.back')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="lede">{t('upload.peopleBody')}</p>
          <div
            className="people-preview"
            style={{ aspectRatio: String(ratio), '--ratio': String(ratio) } as CSSProperties}
          >
            <img src={imageUrl} alt={t('upload.previewAltPending')} />
            {boxes.map((region, index) => (
              <span
                key={index}
                className="people-preview__glow"
                style={boxStyle(region)}
                aria-hidden="true"
              />
            ))}
          </div>
          {message ? (
            <p className="message message--error" role="alert">
              {message}
            </p>
          ) : null}
          <div className="row">
            <button
              type="button"
              className="button button--primary"
              onClick={() => setCropping(true)}
            >
              {t('upload.cropOut')}
            </button>
            <button type="button" className="button" onClick={onKeep}>
              {t('upload.keepAsIs')}
            </button>
            <button type="button" className="button button--quiet" onClick={onReplace}>
              {t('upload.tryAnother')}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
