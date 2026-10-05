/**
 * Grouping consecutive same-lineup days for the schedule browser.
 *
 * CLIENT-SAFE (pure, no imports): the panel and the tests share it. Days are
 * JS weekdays (0=Sunday) matching the grid keys; start/end come back as day
 * counters anchored on the viewed day (start <= viewed <= end, span <= 7),
 * so the panel turns them into dates by adding (edge - viewedDay) days.
 */

/** Maximal identical-lineup run holding `viewedDay`, wrapping the week. */
export function runForDay(sig: (weekday: number) => string, viewedDay: number): { start: number; end: number } {
  const at = (d: number) => sig(((d % 7) + 7) % 7);
  const viewSig = at(viewedDay);
  let start = viewedDay;
  while (start - viewedDay > -6 && at(start - 1) === viewSig) start--;
  let end = viewedDay;
  while (end - start < 6 && at(end + 1) === viewSig) end++;
  return { start, end };
}
