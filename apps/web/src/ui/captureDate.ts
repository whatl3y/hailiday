import { CLIENT_DEFAULTS } from '../config/values';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** Formats a Street View capture date (`YYYY-MM` or `YYYY`) with its granularity. */
export function formatCaptureDate(captureDate: string | null): string | null {
  if (!captureDate) return null;
  const [year, month] = captureDate.split('-');
  if (!year) return null;
  const monthIndex = month ? Number(month) - 1 : -1;
  return monthIndex >= 0 && monthIndex < 12 ? `${MONTHS[monthIndex]} ${year}` : year;
}

/** Whether a capture is old enough (or undated) to invite a current photo. */
export function isOldCapture(captureDate: string | null, now: Date): boolean {
  if (!captureDate) return true;
  const [year, month] = captureDate.split('-').map(Number);
  if (!year) return true;
  const captured = new Date(Date.UTC(year, (month ?? 1) - 1, 1));
  const threshold = new Date(now);
  threshold.setUTCFullYear(threshold.getUTCFullYear() - CLIENT_DEFAULTS.oldCaptureYears);
  return captured < threshold;
}
