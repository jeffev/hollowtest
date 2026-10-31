import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingCost } from './shipping.js';

test('domestic orders of exactly 100 ship free', () => { assert.equal(shippingCost(100), 0); });
test('domestic orders below 100 pay 15', () => { assert.equal(shippingCost(99.99), 15); });
test('international orders pay 40 whatever the total', () => { assert.equal(shippingCost(500, 'US'), 40); });
test('negative totals throw', () => { assert.throws(() => shippingCost(-1), RangeError); });
