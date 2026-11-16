import type { CSSProperties, ReactNode } from 'react';
import { t } from '../copy';
import { cornerClassName, type AiBadgeCorner } from './badgeCorner';

export function FixtureBadge() {
  return (
    <span className="badge badge--fixture" title={t('app.fixtureBadgeLabel')}>
      {t('app.fixtureBadge')}
      <span className="sr-only">{t('app.fixtureBadgeLabel')}</span>
    </span>
  );
}

export function AiPreviewBadge() {
  return <span className="badge badge--ai">{t('result.aiPreview')}</span>;
}

/** A corner of an image frame holding a mark, normally the "AI preview" badge. */
export function ImageCorner({
  corner,
  children = <AiPreviewBadge />,
}: {
  corner: AiBadgeCorner;
  children?: ReactNode;
}) {
  return (
    <div className={cornerClassName('image-card__corner', corner)} data-corner={corner}>
      {children}
    </div>
  );
}

export interface ImageCardProps {
  /** Width over height, used to reserve the frame before the image loads. */
  ratio?: number;
  fixture?: boolean;
  /** Top-right badge (for example "Example"). */
  topEnd?: ReactNode;
  /** Corner mark, used for the "AI preview" badge on generated pixels. */
  corner?: ReactNode;
  /** Which corner holds `corner` (see `aiBadgeCorner`); lower-right by default. */
  cornerPlacement?: AiBadgeCorner;
  /** The strip directly below the image, inside the card (attribution, labels). */
  strip?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A photo in a soft card with its labels and the strip beneath it; nothing covers the strip. */
export function ImageCard({
  ratio = 1,
  fixture,
  topEnd,
  corner,
  cornerPlacement = 'lower-right',
  strip,
  children,
  className,
}: ImageCardProps) {
  const style = { '--frame-ratio': String(ratio) } as CSSProperties;
  // The fixture badge leaves the upper-left corner to a corner mark placed there.
  const fixtureAtEnd = Boolean(corner) && cornerPlacement === 'upper-left';
  const fixtureBadge = fixture ? <FixtureBadge /> : null;
  return (
    <figure className={className ? `image-card ${className}` : 'image-card'} style={{ margin: 0 }}>
      <div className="image-card__frame" style={style}>
        {children}
        {(fixture || topEnd) && (
          <div className="image-card__badges">
            <span>{fixtureAtEnd ? null : fixtureBadge}</span>
            <span className="image-card__badges-end">
              {fixtureAtEnd ? fixtureBadge : null}
              {topEnd}
            </span>
          </div>
        )}
        {corner ? <ImageCorner corner={cornerPlacement}>{corner}</ImageCorner> : null}
      </div>
      {strip ? <figcaption className="image-card__strip">{strip}</figcaption> : null}
    </figure>
  );
}
