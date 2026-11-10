import experienceSpec from '../../../../docs/specs/experience.md?raw';
import { describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  ERROR_CODE_VALUES,
  FEEDBACK_REASON_LABEL_KEYS,
  HOLIDAY_IDS,
  REPORT_REASON_LABEL_KEYS,
  SCENE_TYPES,
  STAGE_LABEL_KEYS,
} from '@holiday/core';
import { COPY_DECK, formatCopy, isCopyKey, sceneTypeLabel, t } from './index';

/** Rows whose single key lists several values; the catalog splits them into these keys. */
const SPLIT_KEYS: Record<string, string[]> = {
  'address.fields': [
    'address.fields.street',
    'address.fields.unit',
    'address.fields.city',
    'address.fields.state',
    'address.fields.zip',
  ],
  'scene.labels': [
    'scene.label.house_exterior',
    'scene.label.apartment_entry',
    'scene.label.balcony',
    'scene.label.dining_room',
    'scene.label.living_room',
    'scene.label.entryway',
    'scene.label.kitchen',
    'scene.label.bedroom',
    'scene.label.room',
  ],
  'controls.style': ['controls.style.subtle', 'controls.style.classic', 'controls.style.abundant'],
  'controls.lighting': ['controls.lighting.source', 'controls.lighting.evening'],
  'footer.links': [
    'footer.terms',
    'footer.privacy',
    'footer.contentPolicy',
    'footer.aiDisclosure',
    'footer.affiliateDisclosure',
    'footer.accessibility',
    'footer.report',
    'footer.optOut',
    'footer.contact',
  ],
};

interface DeckRow {
  keys: string[];
  text: string;
}

/** Reads the copy deck tables (two columns, plus the three-column error table). */
function deckRows(): DeckRow[] {
  const start = experienceSpec.indexOf('## Copy deck');
  const end = experienceSpec.indexOf('## Accessibility');
  const rows: DeckRow[] = [];
  for (const line of experienceSpec.slice(start, end).split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line
      .slice(1, -1)
      .split(' | ')
      .map((cell) => cell.trim());
    const keys = [...cells[0]!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
    rows.push({ keys, text: cells[cells.length - 1]! });
  }
  return rows;
}

function expandKey(key: string): string[] {
  if (key === 'hero.<holidayId>.alt') return HOLIDAY_IDS.map((id) => `hero.${id}.alt`);
  if (key === 'example.<holidayId>.<sceneType>') {
    return HOLIDAY_IDS.flatMap((id) => SCENE_TYPES.map((scene) => `example.${id}.${scene}`));
  }
  return SPLIT_KEYS[key] ?? [key];
}

describe('copy deck', () => {
  const rows = deckRows();

  it('reads the deck from the experience spec', () => {
    expect(rows.length).toBeGreaterThan(150);
  });

  it('has a catalog entry for every key in the experience copy deck', () => {
    const missing = rows
      .flatMap((row) => row.keys)
      .flatMap(expandKey)
      .filter((key) => !isCopyKey(key));
    expect(missing).toEqual([]);
  });

  it('matches the deck wording for every plain row', () => {
    const mismatches: string[] = [];
    for (const row of rows) {
      if (row.keys.length === 0 || row.text.startsWith('Uses ')) continue;
      if (row.keys.some((key) => key.includes('<') || key in SPLIT_KEYS)) continue;
      const text = row.text.replace(/ \(wording owned by .*\)$/, '');
      const values = row.keys.length > 1 ? text.split(' / ') : [text];
      if (values.length !== row.keys.length) continue;
      row.keys.forEach((key, index) => {
        if (isCopyKey(key) && COPY_DECK[key] !== values[index]) {
          mismatches.push(`${key}: "${COPY_DECK[key]}" != "${values[index]}"`);
        }
      });
    }
    expect(mismatches).toEqual([]);
  });

  it('has a non-empty entry for every core error code', () => {
    for (const code of ERROR_CODE_VALUES) {
      const key = ERROR_CODES[code].copyKey;
      expect(isCopyKey(key), key).toBe(true);
      expect(t(key as Parameters<typeof t>[0]).length).toBeGreaterThan(0);
    }
  });

  it('covers the stage labels, holidays and reason labels used by the API', () => {
    for (const key of STAGE_LABEL_KEYS) expect(isCopyKey(key), key).toBe(true);
    for (const id of HOLIDAY_IDS) expect(isCopyKey(`holiday.${id}`)).toBe(true);
    for (const key of Object.values(REPORT_REASON_LABEL_KEYS))
      expect(isCopyKey(key), key).toBe(true);
    for (const key of Object.values(FEEDBACK_REASON_LABEL_KEYS))
      expect(isCopyKey(key), key).toBe(true);
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(t('wait.queuePosition', { n: 3 })).toBe("You're 3 in line");
    expect(formatCopy('Hello {name} {other}', { name: 'there' })).toBe('Hello there {other}');
  });

  it('labels scene types for sentences', () => {
    expect(sceneTypeLabel('balcony')).toBe('balcony or patio');
    expect(sceneTypeLabel('interior', 'dining_room')).toBe('dining room');
    expect(sceneTypeLabel('interior', 'other')).toBe('room');
    expect(t('scene.chip', { sceneTypeLabel: sceneTypeLabel('interior', null) })).toBe(
      'Looks like a room · Change',
    );
  });
});
