// Browser stand-in for the bits of node:path the analyzer uses.
const basename = (p, ext) => {
  const b = String(p).split(/[\/]/).pop();
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export default { basename };
export { basename };
