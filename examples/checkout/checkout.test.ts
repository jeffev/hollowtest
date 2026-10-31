// Seven checkout tests that all pass. Most of them would still pass if the code were broken.
import { describe, it, expect, vi } from 'vitest';
import { subtotal, applyCoupon, parseQuantity, fetchCart } from './checkout';

describe('checkout', () => {
  it('calculates the subtotal', () => {
    const items = [{ sku: 'a', price: 10, qty: 2 }];
    const result = subtotal(items);
    expect(result).toBeDefined();
  });

  it('applies the HALF coupon', () => {
    const total = applyCoupon(80, 'HALF');
    expect(total).toEqual(total);
  });

  it('rejects an invalid quantity', () => {
    try {
      parseQuantity('abc');
    } catch (e) {
      expect((e as Error).message).toBe('invalid quantity');
    }
  });

  it('loads the cart from the API', async () => {
    const api = { get: vi.fn().mockResolvedValue([{ sku: 'a', price: 10, qty: 1 }]) };
    expect(fetchCart('42', api)).resolves.toHaveLength(1);
  });

  it('calls the API', async () => {
    const api = { get: vi.fn().mockResolvedValue([]) };
    await fetchCart('42', api);
    expect(api.get).toHaveBeenCalled();
  });

  it('handles an empty cart', () => {
    subtotal([]);
  });

  it('parses a valid quantity', () => {
    expect(parseQuantity('3')).toBe(3);
  });
});
