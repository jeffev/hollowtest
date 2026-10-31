describe('focus', () => {
  it.only('focused one', () => {
    expect(1 + 1).toBe(2);
  });
  it('silently skipped', () => {
    expect(2 + 2).toBe(4);
  });
});
