/**
 * Paginate a list. Pages are 1-based.
 * Returns { items, page, totalPages, hasNext, hasPrev }.
 * - totalPages is at least 1, even for an empty list.
 * - hasNext is true only when there is a page after the current one.
 * - A page outside 1..totalPages throws a RangeError.
 */
export function paginate(list, page = 1, perPage = 10) {
  const totalPages = Math.max(1, Math.ceil(list.length / perPage));
  if (page < 1 || page > totalPages) throw new RangeError('page out of range');
  const start = (page - 1) * perPage;
  return {
    items: list.slice(start, start + perPage),
    page,
    totalPages,
    hasNext: page <= totalPages,
    hasPrev: page > 1,
  };
}
