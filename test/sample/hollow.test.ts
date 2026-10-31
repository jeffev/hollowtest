import { describe, it, test, expect, vi } from 'vitest';
import { total, fetchUser, parse } from './cart';

describe('hollow tests', () => {
  it('empty body', () => {});

  it('no assertions', () => {
    total([1, 2, 3]);
  });

  it('renders without crashing', () => {
    parse('x');
  });

  it('compares with itself', () => {
    const result = total([1, 2]);
    expect(result).toBe(result);
  });

  it('asserts a literal', () => {
    total([1]);
    expect(true).toBe(true);
  });

  it('literal with unary matcher', () => {
    total([1]);
    expect(1).toBeDefined();
  });

  it('bare expect', () => {
    expect(total([1]));
  });

  it('matcher not called', () => {
    expect(total([1])).toBeTruthy;
  });

  it('expects throw in catch', () => {
    try {
      parse('');
    } catch (e) {
      expect(e.message).toBe('empty');
    }
  });

  it('swallows assertion errors', () => {
    try {
      expect(total([1, 2])).toBe(3);
    } catch (e) {
      console.log(e);
    }
  });

  it('unawaited resolves', async () => {
    expect(fetchUser(1)).resolves.toEqual({ id: 1 });
  });

  it('then without return', () => {
    fetchUser(1).then((u) => {
      expect(u.id).toBe(1);
    });
  });

  it('setTimeout without done', () => {
    setTimeout(() => {
      expect(total([1])).toBe(1);
    }, 10);
  });

  it('only conditional', () => {
    const r = total([1]);
    if (r > 100) {
      expect(r).toBe(101);
    }
  });

  it('only in loop over unknown list', () => {
    const items = parse('a,b').items;
    for (const i of items) {
      expect(i).toBe('a');
    }
  });

  it('commented out', () => {
    const r = total([1, 2]);
    expect(r).toBeGreaterThan(-1000);
    // expect(r).toBe(3);
  });

  it('weak only', () => {
    const r = parse('a');
    expect(r).toBeDefined();
    expect(r).not.toBeNull();
  });

  it('called only', () => {
    const spy = vi.fn();
    total([1], spy);
    expect(spy).toHaveBeenCalled();
  });

  it('snapshot only', () => {
    expect(parse('a')).toMatchSnapshot();
  });

  it.skip('skipped', () => {
    expect(total([1])).toBe(1);
  });

  it.todo('later');

  test('greater than zero is weak', () => {
    expect(total([5]).length).toBeGreaterThan(0);
  });
});
