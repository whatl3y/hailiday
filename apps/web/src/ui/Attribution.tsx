import type { AttributionLogo } from '@hailiday/core';
import { t } from '../copy';
import { attributionParts } from './attributionText';
import { formatCaptureDate } from './captureDate';

/**
 * The attribution strip text directly below a Street View-origin image: the Google Maps logo
 * when required, the per-image credit and the capture date. It is never placed over the image.
 */
export function StreetViewAttribution({
  text,
  logo,
  captureDate,
  fixture = false,
  showCaptureDate = true,
}: {
  text: string | null;
  logo: AttributionLogo | null;
  captureDate: string | null;
  fixture?: boolean;
  showCaptureDate?: boolean;
}) {
  const { showLogo, credit } = attributionParts({ text, logo, fixture });
  const formatted = formatCaptureDate(captureDate);
  const parts = [
    showLogo ? (
      <span key="logo" className="attribution__logo">
        {t('attribution.googleMaps')}
      </span>
    ) : null,
    credit ? <span key="credit">{credit}</span> : null,
    showCaptureDate ? (
      <span key="date">
        {formatted
          ? t('confirm.captureDate', { captureDate: formatted })
          : t('confirm.captureDateUnknown')}
      </span>
    ) : null,
  ].filter((part) => part !== null);
  return (
    <span className="attribution">
      {parts.flatMap((part, index) =>
        index === 0
          ? [part]
          : [
              <span key={`sep-${index}`} className="attribution__sep" aria-hidden="true">
                ·
              </span>,
              part,
            ],
      )}
    </span>
  );
}
