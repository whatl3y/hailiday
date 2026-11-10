import { useEffect, useRef, type RefObject } from 'react';
import { registerChallengeSlot } from '../api/turnstile';

/**
 * Where the bot challenge appears, inline under the control that needed it. While the slot is
 * on screen, a challenge triggered by a request from this surface renders here; the slot takes
 * no space until a challenge needs the person.
 */
export function ChallengeSlot({ elementRef }: { elementRef?: RefObject<HTMLDivElement | null> }) {
  const localRef = useRef<HTMLDivElement>(null);
  const ref = elementRef ?? localRef;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return registerChallengeSlot(element);
  }, [ref]);

  return <div ref={ref} className="challenge-slot" />;
}
