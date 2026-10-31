/**
 * Count business days (Monday to Friday) from `start` (inclusive) to `end` (exclusive).
 * Dates are 'YYYY-MM-DD' strings, interpreted in UTC. Holidays are ignored.
 * If end is not after start, the result is 0.
 */
export function businessDays(start, end) {
  const d = new Date(start + 'T00:00:00Z');
  const stop = new Date(end + 'T00:00:00Z');
  let count = 0;
  while (d < stop) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 7) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}
