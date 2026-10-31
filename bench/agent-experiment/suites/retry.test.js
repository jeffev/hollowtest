import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry } from './retry.js';

test('runs retries + 1 times and rejects with the last error', async () => {
  let n = 0;
  await assert.rejects(retry(async () => { n++; throw new Error('e' + n); }, { retries: 2 }), { message: 'e3' });
  assert.equal(n, 3);
});
test('resolves with the first success', async () => {
  let k = 0;
  assert.equal(await retry(async () => { if (++k < 3) throw new Error('x'); return 'ok'; }, { retries: 2 }), 'ok');
});
