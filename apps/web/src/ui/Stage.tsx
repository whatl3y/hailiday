import type { ReactNode } from 'react';
import { stageStyle } from './stageStyle';

export type StageFill = 'viewport' | 'picture';

export interface StageProps {
  /** The picture's natural width in pixels; the picture is never shown larger. */
  width: number;
  /** The picture's natural height in pixels. */
  height: number;
  /**
   * A rendering or an uploaded photo shown again behind the picture, blurred and darkened, on
   * wide screens. Never a raw Street View frame: those are shown only as they are.
   */
  ambientSrc?: string | null;
  /**
   * `viewport` (default): the stage fills the first viewport under the header and leaves
   * `--stage-peek` for the row under it. `picture`: exactly as tall as the picture at full width.
   */
  fill?: StageFill;
  /** Controls in the stage's upper right corner, never over the picture's lower corners. */
  overlay?: ReactNode;
  /**
   * What hangs from the stage's top edge while a look is being made: the light string and, when
   * there is room, the status card. Above the picture and its sheen, below the stage's controls.
   */
  top?: ReactNode;
  /** The picture layer (an image, the comparison, a pending look); it fills the picture box. */
  children: ReactNode;
  className?: string;
}

/**
 * The ink ground a picture is shown on: the full width of the viewport, edge to edge, with the
 * picture contained and centered at the largest size the screen allows (never above its natural
 * size, never cropped). The box is reserved from the natural size, so nothing shifts as the
 * picture loads. The sizing lives in `stage.css`.
 */
export function Stage({
  width,
  height,
  ambientSrc,
  fill = 'viewport',
  overlay,
  top,
  children,
  className,
}: StageProps) {
  const classes = ['stage', `stage--${fill}`];
  if (overlay) classes.push('stage--overlay');
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} style={stageStyle(width, height)} data-fill={fill}>
      {ambientSrc ? (
        <div className="stage__ambient" aria-hidden="true">
          <img src={ambientSrc} alt="" decoding="async" fetchPriority="low" draggable={false} />
        </div>
      ) : null}
      <div className="stage__picture">{children}</div>
      {top ? <div className="stage__top">{top}</div> : null}
      {overlay ? <div className="stage__overlay">{overlay}</div> : null}
    </div>
  );
}
