import { describe, it, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { total, fetchUser, parse, Cart } from './cart';
import { expectValidCart } from './helpers';

function assertSum(values: number[], expected: number) {
  expect(total(values)).toBe(expected);
}

describe('solid tests', () => {
  it('sums', () => {
    expect(total([1, 2, 3])).toBe(6);
  });

  it('uses local helper', () => {
    assertSum([2, 2], 4);
  });

  it('uses imported helper', () => {
    expectValidCart(parse('a'));
  });

  it('throws', () => {
    expect(() => parse('')).toThrow('empty');
  });

  it('rejects', async () => {
    await expect(fetchUser(-1)).rejects.toThrow('not found');
  });

  it('returns the promise', () => {
    return expect(fetchUser(1)).resolves.toEqual({ id: 1 });
  });

  it('then with return', () => {
    return fetchUser(1).then((u) => {
      expect(u.id).toBe(1);
    });
  });

  it('done callback', (done) => {
    setTimeout(() => {
      expect(total([1])).toBe(1);
      done();
    }, 1);
  });

  it('awaited promise with timer', async () => {
    await new Promise<void>((resolve) => setTimeout(() => {
      expect(total([1])).toBe(1);
      resolve();
    }, 1));
  });

  it('catch with guard', () => {
    expect.assertions(1);
    try {
      parse('');
    } catch (e) {
      expect(e.message).toBe('empty');
    }
  });

  it('catch with fail in try', () => {
    try {
      parse('');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toBe('empty');
    }
  });

  it('loop over literal list', () => {
    for (const n of [1, 2, 3]) {
      expect(total([n])).toBe(n);
    }
  });

  it('conditional plus unconditional', () => {
    const r = parse('a');
    expect(r.items).toEqual(['a']);
    if (r.items.length > 1) expect(r.items[1]).toBe('b');
  });

  it('called with args', () => {
    const spy = vi.fn();
    total([1], spy);
    expect(spy).toHaveBeenCalledWith(1);
  });

  it('renders text', () => {
    render(<Cart items={[]} />);
    expect(screen.getByText('Empty cart')).toBeInTheDocument();
  });

  it('implicit query', () => {
    render(<Cart items={[]} />);
    screen.getByRole('heading', { name: 'Cart' });
  });

  it('weak plus strong', () => {
    const r = parse('a');
    expect(r).toBeDefined();
    expect(r.items).toHaveLength(1);
  });

  it('manual throw assertion', () => {
    const r = total([1, 1]);
    if (r !== 2) throw new Error(`expected 2, got ${r}`);
  });

  it.each([
    [1, 1],
    [2, 2],
  ])('each %i', (a, b) => {
    expect(total([a])).toBe(b);
  });

  test('soft and poll', async () => {
    expect.soft(total([1])).toBe(1);
    await expect.poll(() => total([2])).toBe(2);
  });
});
