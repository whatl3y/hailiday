import { describe, expect, it } from 'vitest';
import { ClientConfigSchema } from './experience.js';
import {
  GALLERY_DEFAULT_LIMIT,
  GalleryItemSchema,
  GalleryQuerySchema,
  GalleryResponseSchema,
} from './gallery.js';
import { isRuntimeSettingKey, runtimeSettingSchemaFor } from './internal.js';

const item = {
  id: '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e',
  projectId: '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5f',
  group: { key: 'place-0123456789abcdef01234567', kind: 'address', label: '14 Lantern Hill Rd' },
  holidayId: 'christmas',
  style: 'abundant',
  lightingMode: 'evening',
  sceneType: 'house_exterior',
  sourceKind: 'street_view',
  createdAt: '2026-11-10T12:00:00.000Z',
  imageUrl: 'http://localhost:9000/hailiday-private/outputs/a/b/full.jpg?X-Amz-Signature=x',
  width: 1536,
  height: 1024,
  beforeImageUrl: null,
  downloadUrl: null,
  attribution: { text: 'Google Maps · © 2026 Google', logo: 'google_maps' },
};

describe('gallery schemas', () => {
  it('accepts a gallery page and refuses unknown fields and kinds', () => {
    expect(GalleryResponseSchema.parse({ items: [item], nextCursor: null }).items).toHaveLength(1);
    expect(
      GalleryItemSchema.safeParse({
        ...item,
        group: { ...item.group, label: null, kind: 'upload' },
      }).success,
    ).toBe(true);
    expect(GalleryItemSchema.safeParse({ ...item, sourceKind: 'fixture' }).success).toBe(false);
    expect(
      GalleryItemSchema.safeParse({ ...item, group: { ...item.group, kind: 'place' } }).success,
    ).toBe(false);
    expect(GalleryItemSchema.safeParse({ ...item, placeId: 'ChIJ' }).success).toBe(false);
  });

  it('carries the Street View credit, or null for an upload', () => {
    expect(GalleryItemSchema.parse(item).attribution).toEqual({
      text: 'Google Maps · © 2026 Google',
      logo: 'google_maps',
    });
    expect(
      GalleryItemSchema.safeParse({ ...item, sourceKind: 'upload', attribution: null }).success,
    ).toBe(true);
    const { attribution: _attribution, ...withoutAttribution } = item;
    expect(GalleryItemSchema.safeParse(withoutAttribution).success).toBe(false);
    expect(
      GalleryItemSchema.safeParse({ ...item, attribution: { text: 'x', logo: 'bing' } }).success,
    ).toBe(false);
    expect(
      GalleryItemSchema.safeParse({ ...item, attribution: { text: '', logo: 'google_maps' } })
        .success,
    ).toBe(false);
  });

  it('pages 60 items by default and at most 100', () => {
    expect(GalleryQuerySchema.parse({})).toEqual({ limit: GALLERY_DEFAULT_LIMIT });
    expect(GALLERY_DEFAULT_LIMIT).toBe(60);
    expect(GalleryQuerySchema.parse({ limit: '100', cursor: 'abc' })).toEqual({
      limit: 100,
      cursor: 'abc',
    });
    expect(GalleryQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(GalleryQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});

describe('retention configuration', () => {
  it('carries the time-based deletion flag in the client configuration', () => {
    const base = {
      autocompleteMinChars: 3,
      autocompleteDebounceMs: 250,
      uploadMaxBytes: 26214400,
      uploadAcceptedTypes: ['image/jpeg'],
      pollRenderMs: 3000,
      pollUploadMs: 2000,
    };
    expect(ClientConfigSchema.safeParse(base).success).toBe(false);
    expect(
      ClientConfigSchema.parse({ ...base, retention: { timeBasedDeletion: false } }).retention,
    ).toEqual({ timeBasedDeletion: false });
  });

  it('defines the boolean runtime setting retention.time_based_deletion', () => {
    expect(isRuntimeSettingKey('retention.time_based_deletion')).toBe(true);
    const schema = runtimeSettingSchemaFor('retention.time_based_deletion');
    expect(schema?.safeParse(true).success).toBe(true);
    expect(schema?.safeParse('yes').success).toBe(false);
  });
});
