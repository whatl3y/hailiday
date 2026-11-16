import { describe, expect, it } from 'vitest';
import type { ExperienceHoliday } from '@hailiday/core';
import { galleryItem, plainSpaces } from '../../test/fixtures';
import {
  SWIPE_MIN_PX,
  appendPage,
  galleryLookLabel,
  galleryOrder,
  groupGallery,
  groupHeading,
  swipeStep,
} from './gallery';

const interiorOffer = {
  styles: ['subtle', 'classic', 'abundant'],
  defaultStyle: 'abundant',
  lightingModes: ['source'],
  defaultLightingMode: 'source',
} as const;

const holidays = [
  {
    id: 'christmas',
    sceneTypes: {
      interior: interiorOffer,
      house_exterior: { ...interiorOffer, lightingModes: ['source', 'evening'] },
    },
  },
] as unknown as ExperienceHoliday[];

describe('gallery groups', () => {
  it('groups by place key in newest-first order, keeping item order inside each group', () => {
    const a1 = galleryItem({ group: { key: 'a', kind: 'address', label: 'A street' } });
    const b1 = galleryItem({ group: { key: 'b', kind: 'upload', label: null } });
    const a2 = galleryItem({ group: { key: 'a', kind: 'address', label: 'A street' } });
    const groups = groupGallery([a1, b1, a2]);
    expect(groups.map((group) => group.key)).toEqual(['a', 'b']);
    expect(groups[0]!.items).toEqual([a1, a2]);
    expect(groups[1]!.heading).toBe('Your photo');
  });

  it('heads a group with its label, "Your photo" for uploads, or the date when unlabelled', () => {
    expect(groupHeading(galleryItem())).toBe('14 Lantern Hill Rd, Maplebrook, VT 05341, USA');
    expect(groupHeading(galleryItem({ group: { key: 'u', kind: 'upload', label: null } }))).toBe(
      'Your photo',
    );
    expect(
      groupHeading(
        galleryItem({
          group: { key: 'p', kind: 'address', label: null },
          createdAt: '2026-11-09T12:00:00.000Z',
        }),
      ),
    ).toBe('November 9, 2026');
  });

  it('adds a page without repeating items already loaded', () => {
    const first = galleryItem();
    const second = galleryItem();
    expect(appendPage([first], [first, second])).toEqual([first, second]);
  });
});

describe('gallery look labels', () => {
  it('names the lighting only where the scene offers a choice', () => {
    expect(plainSpaces(galleryLookLabel(galleryItem(), holidays))).toBe(
      'Christmas · Abundant · Evening',
    );
    expect(
      plainSpaces(
        galleryLookLabel(galleryItem({ sceneType: 'interior', lightingMode: 'source' }), holidays),
      ),
    ).toBe('Christmas · Abundant');
  });

  it('never names bright lighting under a thumbnail', () => {
    expect(
      plainSpaces(
        galleryLookLabel(
          galleryItem({ sceneType: 'interior', lightingMode: 'bright', sourceKind: 'upload' }),
          null,
        ),
      ),
    ).toBe('Christmas · Abundant');
  });
});

describe('the viewer order and swipes', () => {
  it('steps through the renderings group by group, as the page shows them', () => {
    const a1 = galleryItem({ group: { key: 'a', kind: 'address', label: 'A' } });
    const b1 = galleryItem({ group: { key: 'b', kind: 'upload', label: null } });
    const a2 = galleryItem({ group: { key: 'a', kind: 'address', label: 'A' } });
    expect(galleryOrder(groupGallery([a1, b1, a2])).map((item) => item.id)).toEqual([
      a1.id,
      a2.id,
      b1.id,
    ]);
  });

  it('reads a swipe to the left as next and to the right as previous', () => {
    expect(swipeStep(-SWIPE_MIN_PX, 0)).toBe(1);
    expect(swipeStep(SWIPE_MIN_PX, 10)).toBe(-1);
  });

  it('ignores a short or mostly vertical swipe', () => {
    expect(swipeStep(-(SWIPE_MIN_PX - 1), 0)).toBe(0);
    expect(swipeStep(-120, 140)).toBe(0);
    expect(swipeStep(0, 0)).toBe(0);
  });
});
