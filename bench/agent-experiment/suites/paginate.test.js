import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from './paginate.js';

const list = Array.from({ length: 25 }, (_, i) => i);
test('the last page has no next page', () => { assert.equal(paginate(list, 3).hasNext, false); });
test('a middle page has a next page', () => { assert.equal(paginate(list, 2).hasNext, true); });
test('an empty list still has one page', () => { assert.equal(paginate([], 1).totalPages, 1); });
test('pages past the end throw', () => { assert.throws(() => paginate(list, 4), RangeError); });
