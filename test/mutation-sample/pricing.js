export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

export function shipping(total) {
  if (total >= 100) return 0;
  return 15;
}

export function discount(total, coupon) {
  if (coupon === 'HALF' && total > 50) {
    return total / 2;
  }
  return total;
}
