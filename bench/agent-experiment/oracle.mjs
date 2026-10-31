// Spec checks per module: each must pass on fixed/ and the planted-bug check must fail on modules/.
import assert from 'node:assert/strict';
export const ORACLE = {
  shipping: async (m) => { assert.equal(m.shippingCost(100), 0); assert.equal(m.shippingCost(99.99), 15); assert.equal(m.shippingCost(500, 'US'), 40); assert.throws(() => m.shippingCost(-1), RangeError); },
  password: async (m) => { assert.deepEqual(m.validatePassword('Abcdef1'), { valid: false, errors: ['too short'] }); assert.equal(m.validatePassword('Abcdefg1').valid, true); assert.deepEqual(m.validatePassword('abc').errors, ['too short', 'needs a digit', 'needs an uppercase letter']); },
  coupon: async (m) => { assert.equal(m.applyCoupon(100, 'half'), 50); assert.equal(m.applyCoupon(50, 'HALF'), 50); assert.equal(m.applyCoupon(30, 'TENOFF'), 20); assert.throws(() => m.applyCoupon(100, 'XYZ'), { name: 'RangeError', message: 'unknown coupon' }); },
  paginate: async (m) => { const l = Array.from({ length: 25 }, (_, i) => i); assert.equal(m.paginate(l, 3).hasNext, false); assert.equal(m.paginate(l, 2).hasNext, true); assert.equal(m.paginate([], 1).totalPages, 1); assert.throws(() => m.paginate(l, 4), RangeError); },
  slugify: async (m) => { assert.equal(m.slugify('Ação Rápida!'), 'acao-rapida'); assert.equal(m.slugify('a'.repeat(29) + ' b'), 'a'.repeat(29)); assert.ok(m.slugify('x'.repeat(40)).length <= 30); },
  retry: async (m) => { let n = 0; await assert.rejects(m.retry(async () => { n++; throw new Error('e' + n); }, { retries: 2 }), { message: 'e3' }); assert.equal(n, 3); let k = 0; assert.equal(await m.retry(async () => { if (++k < 3) throw new Error('x'); return 'ok'; }, { retries: 2 }), 'ok'); },
  splitBill: async (m) => { assert.deepEqual(m.splitBill(100, 3), [34, 33, 33]); assert.deepEqual(m.splitBill(90, 3), [30, 30, 30]); assert.throws(() => m.splitBill(100, 0), RangeError); },
  businessDays: async (m) => { assert.equal(m.businessDays('2026-11-02', '2026-11-09'), 5); assert.equal(m.businessDays('2026-11-07', '2026-11-09'), 0); assert.equal(m.businessDays('2026-11-09', '2026-11-02'), 0); },
};
if (process.argv[1].endsWith('oracle.mjs')) {
  const { pathToFileURL } = await import('node:url');
  for (const [name, check] of Object.entries(ORACLE)) {
    const res = {};
    for (const dir of ['fixed', 'modules']) {
      try { await check(await import(pathToFileURL(`${process.cwd()}/${dir}/${name}.js`).href)); res[dir] = 'pass'; } catch (e) { res[dir] = 'FAIL'; }
    }
    console.log(name.padEnd(13), 'fixed:', res.fixed, ' buggy:', res.modules);
  }
}
