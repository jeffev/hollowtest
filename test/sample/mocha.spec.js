const { expect } = require('chai');
const assert = require('node:assert');
const request = require('supertest');
const { total } = require('./cart');

describe('mocha + chai', function () {
  it('chai equal', function () {
    expect(total([1, 2])).to.equal(3);
  });
  it('chai property terminal', function () {
    expect(total([1]) === 1).to.be.true;
  });
  it('node assert', function () {
    assert.strictEqual(total([2]), 2);
  });
  it('supertest expect', async function () {
    await request(app).get('/health').expect(200);
  });
  it('should style', function () {
    total([1]).should.equal(1);
  });
  it('assert ok weak', function () {
    const result = total([1]);
    assert.ok(result);
  });
  it('assert tautology', function () {
    const r = total([1]);
    assert.equal(r, r);
  });
});
