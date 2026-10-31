import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subtotal, shipping, discount } from './pricing.js';

// solid: these fail if subtotal or shipping break
test('subtotal multiplies price by quantity', () => {
  assert.equal(subtotal([{ price: 10, qty: 3 }, { price: 5, qty: 1 }]), 35);
});

test('free shipping from 100', () => {
  assert.equal(shipping(100), 0);
  assert.equal(shipping(99.99), 15);
});

// hollow: an agent "covered" discount() without checking the result
test('discount works', () => {
  const result = discount(80, 'HALF');
  assert.ok(result);
});
