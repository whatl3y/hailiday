import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import type { HolidayId } from '@hailiday/core';
import {
  BULB_SOCKET,
  HANGER_INSET,
  STRING_PIN_Y,
  stringGeometry,
  type StringTier,
} from './stringGeometry';
import { useReducedMotion } from './motion';
import './light-string.css';

export interface LightStringProps {
  /** The holiday whose colours the bulbs wear; null gives warm white. */
  holidayId: HolidayId | null;
  tier: StringTier;
  /** Draws the two hangers down to a status card of this width whose top edge is at `top`. */
  hang?: { width: number; top: number } | null;
}

/** A poke of the same bulb within this time is the same poke (a touch sends two events). */
const POKE_REPEAT_MS = 250;
/** How far, in bulbs, a poke's ripple travels each way. */
const RIPPLE_REACH = 8;

interface Pokes {
  /** How many colours each poked bulb has moved on. */
  offsets: Record<number, number>;
  /** The bulb poked last, the centre of the ripple. */
  poke: number | null;
  /** Counts pokes, so each ripple starts again. */
  seq: number;
}

function initialWidth(): number {
  return (typeof document !== 'undefined' && document.documentElement.clientWidth) || 1024;
}

/**
 * A string of holiday lights along a stage's top edge while a look is being made: a wire pinned
 * at the stage's edges and sagging in even swags, with bulbs in the holiday's three colours that
 * twinkle in a wave along it. A bulb the pointer passes over or taps changes colour and sends a
 * ripple to its neighbours; nothing is stored, sent or counted, and a touch that starts on the
 * string still scrolls the page. It is decoration only: hidden from assistive technology, never
 * focusable, never a control.
 */
export function LightString({ holidayId, tier, hang = null }: LightStringProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initialWidth);
  const [pokes, setPokes] = useState<Pokes>({ offsets: {}, poke: null, seq: 0 });
  const lastPoke = useRef<{ index: number; at: number }>({ index: -1, at: 0 });
  const reducedMotion = useReducedMotion();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      if (root.clientWidth > 0) setWidth(root.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => stringGeometry(width, tier), [width, tier]);

  function poke(event: PointerEvent<SVGSVGElement>) {
    const target = event.target as Element | null;
    const bulb = target?.closest?.('.bulb');
    const index = Number(bulb?.getAttribute('data-index'));
    if (!bulb || !Number.isInteger(index)) return;
    const now = Date.now();
    if (lastPoke.current.index === index && now - lastPoke.current.at < POKE_REPEAT_MS) return;
    lastPoke.current = { index, at: now };
    setPokes((current) => ({
      offsets: { ...current.offsets, [index]: (current.offsets[index] ?? 0) + 1 },
      poke: index,
      seq: current.seq + 1,
    }));
  }

  const cardWidth = hang ? Math.min(hang.width, width - 32) : 0;
  const hangers = hang
    ? [width / 2 - (cardWidth / 2 - HANGER_INSET), width / 2 + (cardWidth / 2 - HANGER_INSET)]
    : [];
  const { radius } = tier;

  return (
    <div
      ref={rootRef}
      className="light-string"
      data-holiday={holidayId ?? undefined}
      aria-hidden="true"
    >
      <svg
        className="light-string__svg"
        width={width}
        height={tier.clear}
        viewBox={`0 0 ${width} ${tier.clear}`}
        focusable="false"
        onPointerOver={poke}
        onPointerDown={poke}
      >
        <defs>
          {[1, 2, 3].map((n) => (
            <radialGradient key={n} id={`${id}-glow-${n}`}>
              <stop offset="0" style={{ stopColor: `var(--bulb-${n})`, stopOpacity: 0.6 }} />
              <stop offset="0.45" style={{ stopColor: `var(--bulb-${n})`, stopOpacity: 0.22 }} />
              <stop offset="1" style={{ stopColor: `var(--bulb-${n})`, stopOpacity: 0 }} />
            </radialGradient>
          ))}
          <radialGradient id={`${id}-flash`}>
            <stop offset="0" stopColor="white" stopOpacity="0.9" />
            <stop offset="1" stopColor="white" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path className="light-string__under" d={geometry.wire} />
        <path className="light-string__wire" d={geometry.wire} />
        {geometry.pins.map((x) => (
          <circle key={x} className="light-string__pin" cx={x} cy={STRING_PIN_Y} r={1.4} />
        ))}
        {hangers.map((x, index) => (
          <g key={index} className="light-string__hanger">
            <line
              className="light-string__hanger-under"
              x1={x}
              y1={geometry.wireY(x)}
              x2={x}
              y2={hang!.top}
            />
            <line
              className="light-string__hanger-wire"
              x1={x}
              y1={geometry.wireY(x)}
              x2={x}
              y2={hang!.top}
            />
          </g>
        ))}
        {geometry.bulbs.map((bulb) => {
          const colour = ((bulb.colour + (pokes.offsets[bulb.index] ?? 0)) % 3) + 1;
          const distance = pokes.poke === null ? null : Math.abs(bulb.index - pokes.poke);
          const flash = !reducedMotion && distance !== null && distance <= RIPPLE_REACH;
          return (
            <g
              key={bulb.index}
              className="bulb"
              data-index={bulb.index}
              style={{ '--i': bulb.index } as CSSProperties}
            >
              <rect
                className="bulb__hit"
                x={bulb.x - geometry.spacing / 2}
                y={0}
                width={geometry.spacing}
                height={tier.clear}
              />
              <circle
                className="bulb__glow"
                cx={bulb.x}
                cy={bulb.y}
                r={2.6 * radius}
                fill={`url(#${id}-glow-${colour})`}
              />
              <rect
                className="bulb__socket"
                x={bulb.x - 1.5}
                y={bulb.wireY - 0.5}
                width={3}
                height={BULB_SOCKET + 0.5}
                rx={0.8}
              />
              <circle
                className="bulb__body"
                cx={bulb.x}
                cy={bulb.y}
                r={radius}
                style={{ fill: `var(--bulb-${colour})` }}
              />
              <circle
                className="bulb__shine"
                cx={bulb.x - radius / 3}
                cy={bulb.y - radius / 3}
                r={0.24 * radius}
              />
              {flash ? (
                <circle
                  key={pokes.seq}
                  className="bulb__flash"
                  cx={bulb.x}
                  cy={bulb.y}
                  r={1.9 * radius}
                  fill={`url(#${id}-flash)`}
                  style={{ '--d': distance, '--a': 1 - distance / 9 } as CSSProperties}
                />
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
