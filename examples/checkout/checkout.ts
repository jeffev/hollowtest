export type Item = { sku: string; price: number; qty: number };

export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

export function applyCoupon(total: number, code: string): number {
  if (code === 'HALF' && total > 50) return total / 2;
  return total;
}

export function parseQuantity(input: string): number {
  const n = Number(input);
  if (!Number.isInteger(n) || n < 1) throw new Error('invalid quantity');
  return n;
}

export async function fetchCart(id: string, api: { get(url: string): Promise<Item[]> }) {
  return api.get(`/carts/${id}`);
}
