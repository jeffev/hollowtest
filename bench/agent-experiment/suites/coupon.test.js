import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCoupon } from './coupon.js';

test('HALF halves totals above 50, case-insensitive', () => { assert.equal(applyCoupon(100, 'half'), 50); });
test('HALF does nothing at exactly 50', () => { assert.equal(applyCoupon(50, 'HALF'), 50); });
test('TENOFF takes 10 off from 30', () => { assert.equal(applyCoupon(30, 'TENOFF'), 20); });
test('unknown codes throw', () => { assert.throws(() => applyCoupon(100, 'XYZ'), { name: 'RangeError', message: 'unknown coupon' }); });
