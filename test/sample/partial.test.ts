import { vi, it, expect } from 'vitest';
import { total } from './partial';

vi.mock('./partial', async (importOriginal) => ({ ...(await importOriginal()), log: vi.fn() }));

it('partial mock is fine', () => {
  expect(total([1, 2, 3])).toBe(6);
});
