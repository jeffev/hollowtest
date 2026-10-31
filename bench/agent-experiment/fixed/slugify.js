/**
 * Turn a title into a URL slug.
 * - lowercase, accents removed ('Ação' -> 'acao')
 * - every run of characters other than a-z and 0-9 becomes a single '-'
 * - no leading or trailing '-'
 * - at most 30 characters, and still no trailing '-' after cutting
 */
export function slugify(title) {
  const base = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, 30).replace(/-+$/, '');
}
