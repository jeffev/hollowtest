import test from 'node:test';
import assert from 'node:assert/strict';
import { total } from './cart.js';

test('node:test with assert', () => {
  assert.equal(total([1, 2]), 3);
});

test('node:test with t.assert', (t) => {
  t.assert.deepStrictEqual([total([1])], [1]);
});

test('node:test no assertions', () => {
  total([1]);
});
