import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from './slugify.js';

test('lowercases and strips accents', () => { assert.equal(slugify('Ação Rápida!'), 'acao-rapida'); });
test('no trailing dash after cutting to 30 chars', () => { assert.equal(slugify('a'.repeat(29) + ' b'), 'a'.repeat(29)); });
test('never longer than 30 chars', () => { assert.ok(slugify('x'.repeat(40)).length <= 30); });
