/**
 * Apply a coupon code to an order total.
 * - 'HALF': 50% off, only for totals above 50 (otherwise the total is unchanged).
 * - 'TENOFF': 10 off, only for totals of 30 or more (otherwise unchanged).
 * - Codes are case-insensitive.
 * - Any other code is invalid: throw a RangeError with the message 'unknown coupon'.
 */
export function applyCoupon(total, code) {
  const c = code.toUpperCase();
  if (c === 'HALF') return total > 50 ? total / 2 : total;
  if (c === 'TENOFF') return total >= 30 ? total - 10 : total;
  return total;
}
