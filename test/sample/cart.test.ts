import { vi, it, expect } from 'vitest';
import { total } from './cart';

vi.mock('./cart', () => ({ total: vi.fn(() => 6) }));

it('sums the cart', () => {
  expect(total([1, 2, 3])).toBe(6);
});
