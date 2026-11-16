/**
 * Splits a look label into its leading holiday part (the holiday name and the separator after
 * it) and the rest, or returns null when the label does not start that way. The label joins
 * the words of each part with no-break spaces, so spaces of either kind match.
 */
export function splitLeadingHoliday(
  label: string,
  holiday: string,
): { lead: string; rest: string } | null {
  const spaced = (text: string) => text.replace(/\s/gu, ' ');
  if (!spaced(label).startsWith(spaced(holiday))) return null;
  const separator = /^\s*·\s*/u.exec(label.slice(holiday.length));
  if (!separator) return null;
  const cut = holiday.length + separator[0].length;
  return { lead: label.slice(0, cut), rest: label.slice(cut) };
}
