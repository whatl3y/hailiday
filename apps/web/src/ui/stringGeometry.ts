import { useSyncExternalStore } from 'react';

/**
 * The geometry of the light string that hangs along a stage's top edge while a look is being
 * made. The wire is pinned at both edges of the stage and at every multiple of the swag length,
 * and sags between pins as a parabola; the bulbs hang at even spacing along each swag. The tier
 * comes from the same media queries the stylesheets use, never from a measured width, so the
 * string, the card's hangers and the marks under the string agree at every width.
 */

export type StringTierName = 'compact' | 'medium' | 'wide';

export interface StringTier {
  /** Target swag length; the real length divides the stage's width evenly. */
  unit: number;
  /** How far the wire's lowest point hangs below its pins. */
  sag: number;
  radius: number;
  perSwag: number;
  /** Below this distance from the stage's top edge nothing of the string is drawn solid; marks
   *  and the card start here or lower. */
  clear: number;
  /** The status card's top edge on the stage. */
  cardTop: number;
}

export const STRING_TIERS: Record<StringTierName, StringTier> = {
  compact: { unit: 104, sag: 14, radius: 3.5, perSwag: 3, clear: 36, cardTop: 40 },
  medium: { unit: 128, sag: 18, radius: 4, perSwag: 4, clear: 40, cardTop: 44 },
  wide: { unit: 144, sag: 22, radius: 4.5, perSwag: 4, clear: 44, cardTop: 50 },
};

/**
 * The card's top edge from 600 px when the picture carries a mark at its upper left (the AI
 * preview mark of a Street View look), and between 600 and 1023 px when the Before / AI preview
 * switch is on the stage: below the lowest of them.
 */
export const CARD_TOP_BELOW_SWITCH = 84;
/** Where the wire is pinned, below the stage's top edge. */
export const STRING_PIN_Y = 1;
/** The socket's length between the wire and a bulb's body. */
export const BULB_SOCKET = 3;
/** The status card's width on the stage (23rem); it is `min(23rem, stage width − 32px)`. */
export const STATUS_CARD_WIDTH = 368;
/** How far each hanger stands in from the card's side edges. */
export const HANGER_INSET = 32;
/** The status card hangs on the stage only on screens this wide and this tall. */
export const CARD_ON_STAGE_QUERY = '(min-width: 600px) and (min-height: 560px)';

const MEDIUM_QUERY = '(min-width: 600px)';
const WIDE_QUERY = '(min-width: 1024px)';

export interface StringBulb {
  index: number;
  x: number;
  /** Where the bulb's socket meets the wire. */
  wireY: number;
  /** The centre of the bulb's body. */
  y: number;
  colour: 0 | 1 | 2;
}

export interface StringGeometry {
  width: number;
  height: number;
  swags: number;
  unit: number;
  spacing: number;
  tier: StringTier;
  /** The SVG path of the wire, one quadratic curve per swag. */
  wire: string;
  /** The x of every pin, from 0 to `width`. */
  pins: number[];
  bulbs: StringBulb[];
  /** The wire's height at `x`. */
  wireY(x: number): number;
}

const fixed = (value: number) => Number(value.toFixed(2));

/** The string across a stage `width` px wide. */
export function stringGeometry(width: number, tier: StringTier): StringGeometry {
  const swags = Math.max(2, Math.round(width / tier.unit));
  const unit = width / swags;
  const wireY = (x: number): number => {
    const t = (((x % unit) + unit) % unit) / unit;
    return STRING_PIN_Y + 4 * tier.sag * t * (1 - t);
  };
  const pins: number[] = [];
  const bulbs: StringBulb[] = [];
  let wire = '';
  for (let k = 0; k <= swags; k += 1) pins.push(k === swags ? width : k * unit);
  for (let k = 0; k < swags; k += 1) {
    const x0 = k * unit;
    wire += `M${fixed(x0)} ${STRING_PIN_Y}Q${fixed(x0 + unit / 2)} ${STRING_PIN_Y + 2 * tier.sag} ${fixed(x0 + unit)} ${STRING_PIN_Y}`;
    for (let j = 0; j < tier.perSwag; j += 1) {
      const x = x0 + (unit * (j + 0.5)) / tier.perSwag;
      const index = k * tier.perSwag + j;
      const y = wireY(x);
      bulbs.push({
        index,
        x,
        wireY: y,
        y: y + BULB_SOCKET + tier.radius,
        colour: (index % 3) as 0 | 1 | 2,
      });
    }
  }
  return {
    width,
    height: tier.clear,
    swags,
    unit,
    spacing: unit / tier.perSwag,
    tier,
    wire,
    pins,
    bulbs,
    wireY,
  };
}

function mediaQuery(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
}

function subscribeTo(queries: readonly string[]) {
  return (onChange: () => void): (() => void) => {
    const lists = queries.map(mediaQuery).filter((list): list is MediaQueryList => list !== null);
    for (const list of lists) list.addEventListener('change', onChange);
    return () => {
      for (const list of lists) list.removeEventListener('change', onChange);
    };
  };
}

const subscribeTier = subscribeTo([MEDIUM_QUERY, WIDE_QUERY]);
const subscribeCard = subscribeTo([CARD_ON_STAGE_QUERY]);

function currentTier(): StringTierName {
  if (mediaQuery(WIDE_QUERY)?.matches) return 'wide';
  if (mediaQuery(MEDIUM_QUERY)?.matches) return 'medium';
  return 'compact';
}

function cardOnStage(): boolean {
  return mediaQuery(CARD_ON_STAGE_QUERY)?.matches ?? false;
}

/** The string's tier for the viewport: compact under 600 px, medium under 1024 px, wide above. */
export function useStringTier(): StringTierName {
  return useSyncExternalStore(subscribeTier, currentTier, () => 'compact');
}

/** Whether the status card hangs on the stage (at least 600 px wide and 560 px tall). */
export function useCardOnStage(): boolean {
  return useSyncExternalStore(subscribeCard, cardOnStage, () => false);
}
