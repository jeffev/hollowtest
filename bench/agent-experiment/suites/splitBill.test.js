import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBill } from './splitBill.js';

test('extra cents go to the first people', () => { assert.deepEqual(splitBill(100, 3), [34, 33, 33]); });
test('even splits stay even', () => { assert.deepEqual(splitBill(90, 3), [30, 30, 30]); });
test('zero people throws', () => { assert.throws(() => splitBill(100, 0), RangeError); });
