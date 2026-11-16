import { describe, expect, it } from 'vitest';
import {
  BULB_SOCKET,
  CARD_ON_STAGE_QUERY,
  STRING_PIN_Y,
  STRING_TIERS,
  stringGeometry,
  type StringTierName,
} from './stringGeometry';

/** The string at each width the design was drawn at: its tier, swags, swag length and spacing. */
const TABLE: [number, StringTierName, number, number, number, number][] = [
  // width, tier, swags, swag length, bulbs per swag, bulb spacing
  [320, 'compact', 3, 106.7, 3, 35.6],
  [390, 'compact', 4, 97.5, 3, 32.5],
  [768, 'medium', 6, 128, 4, 32],
  [1024, 'wide', 7, 146.3, 4, 36.6],
  [1440, 'wide', 10, 144, 4, 36],
  [1920, 'wide', 13, 147.7, 4, 36.9],
];

describe('the light string tiers', () => {
  it('hang deeper and wider as the screen grows, with the card under the clear band', () => {
    expect(STRING_TIERS).toEqual({
      compact: { unit: 104, sag: 14, radius: 3.5, perSwag: 3, clear: 36, cardTop: 40 },
      medium: { unit: 128, sag: 18, radius: 4, perSwag: 4, clear: 40, cardTop: 44 },
      wide: { unit: 144, sag: 22, radius: 4.5, perSwag: 4, clear: 44, cardTop: 50 },
    });
    for (const tier of Object.values(STRING_TIERS)) {
      expect(tier.cardTop).toBeGreaterThan(tier.clear);
    }
    expect(CARD_ON_STAGE_QUERY).toBe('(min-width: 600px) and (min-height: 560px)');
  });
});

describe('stringGeometry', () => {
  it.each(TABLE)(
    'at %ipx (%s) hangs the swags, the swag length and the bulbs of the design',
    (width, tierName, swags, unit, perSwag, spacing) => {
      const tier = STRING_TIERS[tierName];
      const geometry = stringGeometry(width, tier);
      expect(geometry.swags).toBe(swags);
      expect(geometry.unit).toBeCloseTo(unit, 1);
      expect(geometry.spacing).toBeCloseTo(spacing, 1);
      expect(geometry.bulbs).toHaveLength(swags * perSwag);
      expect(geometry.height).toBe(tier.clear);
      // Pinned at both edges of the stage and between every swag.
      expect(geometry.pins).toHaveLength(swags + 1);
      expect(geometry.pins[0]).toBe(0);
      expect(geometry.pins.at(-1)).toBe(width);
      // Nothing solid reaches the clear band's lower edge: the lowest bulb ends 9px or more above.
      for (const bulb of geometry.bulbs) {
        expect(bulb.y + tier.radius).toBeLessThanOrEqual(tier.clear - 9);
      }
      const lowest = STRING_PIN_Y + tier.sag + BULB_SOCKET + 2 * tier.radius;
      expect(Math.max(...geometry.bulbs.map((bulb) => bulb.y + tier.radius))).toBeLessThan(
        lowest + 0.001,
      );
    },
  );

  it('sags each swag as a parabola from pin to pin', () => {
    const tier = STRING_TIERS.wide;
    const geometry = stringGeometry(1440, tier);
    for (const pin of geometry.pins.slice(0, -1)) {
      expect(geometry.wireY(pin)).toBeCloseTo(STRING_PIN_Y, 6);
      expect(geometry.wireY(pin + geometry.unit / 2)).toBeCloseTo(STRING_PIN_Y + tier.sag, 6);
    }
    expect(geometry.wire.match(/M/g)).toHaveLength(geometry.swags);
    expect(
      geometry.wire.startsWith(`M0 ${STRING_PIN_Y}Q72 ${STRING_PIN_Y + 2 * tier.sag} 144 1`),
    ).toBe(true);
  });

  it('hangs each bulb from the wire by its socket and cycles the three colours', () => {
    const tier = STRING_TIERS.compact;
    const geometry = stringGeometry(390, tier);
    geometry.bulbs.forEach((bulb, index) => {
      expect(bulb.index).toBe(index);
      expect(bulb.colour).toBe(index % 3);
      expect(bulb.wireY).toBeCloseTo(geometry.wireY(bulb.x), 6);
      expect(bulb.y).toBeCloseTo(bulb.wireY + BULB_SOCKET + tier.radius, 6);
    });
    const first = geometry.bulbs[0]!;
    expect(first.x).toBeCloseTo(geometry.unit / (2 * tier.perSwag), 6);
  });

  it('keeps at least two swags on a narrow stage', () => {
    expect(stringGeometry(120, STRING_TIERS.compact).swags).toBe(2);
  });
});
