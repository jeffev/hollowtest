import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessDays } from './businessDays.js';

test('a full week has 5 business days', () => { assert.equal(businessDays('2026-11-02', '2026-11-09'), 5); });
test('a weekend has none', () => { assert.equal(businessDays('2026-11-07', '2026-11-09'), 0); });
test('end before start is 0', () => { assert.equal(businessDays('2026-11-09', '2026-11-02'), 0); });
