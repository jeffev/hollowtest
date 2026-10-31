/**
 * Shipping cost in BRL for an order.
 * - Domestic orders ('BR') of 100 or more ship free.
 * - Other domestic orders pay 15.
 * - International orders always pay a flat 40, whatever the total.
 * - A negative total is a programming error: throw a RangeError.
 */
export function shippingCost(total, country = 'BR') {
  if (total < 0) throw new RangeError('total must be >= 0');
  if (country !== 'BR') return 40;
  if (total >= 100) return 0;
  return 15;
}
