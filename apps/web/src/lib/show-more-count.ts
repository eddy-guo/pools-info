/**
 * The Show more foot's count line. `null` is a count no response has named
 * yet, which prints nothing rather than a zero the list may not have; only a
 * real zero reads "0 results".
 */
export function showMoreCount(shown: number, total: number | null) {
  if (total === null) return "";
  return total
    ? `Showing ${Math.min(shown, total).toLocaleString()} of ${total.toLocaleString()}`
    : "0 results";
}
