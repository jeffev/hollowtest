export function total(values: number[], onItem?: (n: number) => void): number {
  let sum = 0;
  for (const v of values) {
    onItem?.(v);
    sum += v;
  }
  return sum;
}

export function parse(input: string): { items: string[] } {
  if (!input) throw new Error('empty');
  return { items: input.split(',') };
}

export async function fetchUser(id: number) {
  if (id < 0) throw new Error('not found');
  return { id };
}

export function Cart({ items }: { items: string[] }) {
  return items.length ? items.join(',') : 'Empty cart';
}
