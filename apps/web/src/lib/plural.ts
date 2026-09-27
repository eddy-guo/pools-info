/** The noun a count takes: singular for exactly 1, plural for 0 and every
    other count ("0 pools", "1 pool", "2 pools"). */
export function plural(count: number, singular: string, many = `${singular}s`) {
  return count === 1 ? singular : many;
}

/** A count and its noun, with thousands separators as the rest of the site
    prints counts ("1 trade", "30,160 trades"). */
export function countLabel(count: number, singular: string, many?: string) {
  return `${count.toLocaleString("en-US")} ${plural(count, singular, many)}`;
}
