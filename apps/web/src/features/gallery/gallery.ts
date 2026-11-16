import {
  LIGHTING_MODES,
  type ExperienceHoliday,
  type GalleryAttribution,
  type GalleryItem,
} from '@hailiday/core';
import { t } from '../../copy';
import { lookLabel } from '../project/looks';

/** Signed image URLs live 15 minutes; the gallery reads them again before that. */
export const GALLERY_REFRESH_AFTER_MS = 12 * 60 * 1000;

/** Items requested per page. */
export const GALLERY_PAGE_SIZE = 60;

/** The first wait before a failed refresh is tried again; each further failure doubles it. */
export const GALLERY_RETRY_FIRST_MS = 30 * 1000;

/** The longest wait between refresh retries. */
export const GALLERY_RETRY_MAX_MS = 5 * 60 * 1000;

/** The wait before the next refresh retry, given the previous wait (null on the first failure). */
export function nextRetryDelay(previous: number | null): number {
  return previous === null ? GALLERY_RETRY_FIRST_MS : Math.min(previous * 2, GALLERY_RETRY_MAX_MS);
}

/**
 * The attribution shown with a gallery rendering: the item's own credit, or the bare Google Maps
 * logo for a Street View-origin rendering that carries none; null for an uploaded photo.
 */
export function galleryAttribution(item: GalleryItem): GalleryAttribution | null {
  if (item.attribution) return item.attribution;
  return item.sourceKind === 'street_view' ? { text: '', logo: 'google_maps' } : null;
}

export interface GalleryGroup {
  key: string;
  heading: string;
  items: GalleryItem[];
}

export function formatGalleryDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * A group's heading: the place's label, "Your photo" for an uploaded photo, or the date of the
 * newest picture when an address has no stored label.
 */
export function groupHeading(item: GalleryItem): string {
  if (item.group.label) return item.group.label;
  if (item.group.kind === 'upload') return t('result.yourPhoto');
  return formatGalleryDate(item.createdAt);
}

/**
 * Groups newest-first items by `group.key`, keeping the newest-first order of the groups (by
 * their newest item) and of the items inside each group.
 */
export function groupGallery(items: readonly GalleryItem[]): GalleryGroup[] {
  const groups = new Map<string, GalleryGroup>();
  for (const item of items) {
    const group = groups.get(item.group.key);
    if (group) group.items.push(item);
    else
      groups.set(item.group.key, {
        key: item.group.key,
        heading: groupHeading(item),
        items: [item],
      });
  }
  return [...groups.values()];
}

/** The renderings in the order the page shows them: group by group, newest group first. */
export function galleryOrder(groups: readonly GalleryGroup[]): GalleryItem[] {
  return groups.flatMap((group) => group.items);
}

/** The shortest horizontal travel, in CSS pixels, that counts as a swipe in the viewer. */
export const SWIPE_MIN_PX = 48;

/**
 * The step a swipe makes in the viewer: -1 (to the previous picture) for a swipe to the right,
 * 1 (to the next) for a swipe to the left, 0 when the travel is too short or mostly vertical.
 */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return 0;
  return dx > 0 ? -1 : 1;
}

/** Adds a page to the loaded items, keeping one entry per rendering. */
export function appendPage(
  items: readonly GalleryItem[],
  page: readonly GalleryItem[],
): GalleryItem[] {
  const seen = new Set(items.map((item) => item.id));
  return [...items, ...page.filter((item) => !seen.has(item.id))];
}

/**
 * The look under a thumbnail. The lighting is left out where the holiday's pack offers the scene
 * a single lighting mode (an interior is always shown as photographed).
 */
export function galleryLookLabel(
  item: GalleryItem,
  holidays: readonly ExperienceHoliday[] | null,
): string {
  const offer = holidays?.find((holiday) => holiday.id === item.holidayId)?.sceneTypes[
    item.sceneType
  ];
  return lookLabel(item, offer?.lightingModes ?? LIGHTING_MODES);
}
