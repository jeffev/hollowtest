import { expect } from 'vitest';

export function expectValidCart(cart: { items: string[] }) {
  expect(Array.isArray(cart.items)).toBe(true);
  expect(cart.items.length).toBeGreaterThan(0);
}
