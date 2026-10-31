/**
 * Split a bill of `totalCents` among `people`, in whole cents.
 * - The parts always add up to exactly totalCents.
 * - Parts differ by at most 1 cent; the extra cents go to the first people.
 *   splitBill(100, 3) -> [34, 33, 33]
 * - people must be a positive integer, otherwise throw a RangeError.
 */
export function splitBill(totalCents, people) {
  if (!Number.isInteger(people) || people < 1) throw new RangeError('people must be a positive integer');
  const share = Math.round(totalCents / people);
  return Array.from({ length: people }, () => share);
}
