import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePassword } from './password.js';

test('7 characters is too short', () => { assert.deepEqual(validatePassword('Abcdef1'), { valid: false, errors: ['too short'] }); });
test('8 characters with digit and uppercase is valid', () => { assert.deepEqual(validatePassword('Abcdefg1'), { valid: true, errors: [] }); });
test('every broken rule is listed in order', () => { assert.deepEqual(validatePassword('abc').errors, ['too short', 'needs a digit', 'needs an uppercase letter']); });
