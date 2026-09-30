/**
 * The code points a TrueType face maps to a glyph, read from the Unicode
 * subtables of its `cmap` table (format 4 for the Basic Multilingual Plane,
 * format 12 beyond it). The share card strips what its own faces cannot draw
 * with this, rather than with a hand-kept range list: the renderer otherwise
 * fetches a stand-in face or emoji art from a third-party CDN mid-render.
 */
export function fontCodePoints(font: Uint8Array): Set<number> {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const points = new Set<number>();
  let cmap = -1;
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    // The table tag "cmap" as a big-endian uint32.
    if (view.getUint32(record) === 0x636d6170)
      cmap = view.getUint32(record + 8);
  }
  if (cmap < 0) return points;
  for (let i = 0; i < view.getUint16(cmap + 2); i++) {
    const record = cmap + 4 + i * 8,
      platform = view.getUint16(record),
      encoding = view.getUint16(record + 2);
    // Unicode (platform 0) or Windows Unicode BMP and full repertoire.
    if (
      platform !== 0 &&
      !(platform === 3 && (encoding === 1 || encoding === 10))
    )
      continue;
    const table = cmap + view.getUint32(record + 4),
      format = view.getUint16(table);
    if (format === 4) {
      const segments = view.getUint16(table + 6) / 2,
        ends = table + 14,
        starts = ends + segments * 2 + 2,
        deltas = starts + segments * 2,
        offsets = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const start = view.getUint16(starts + s * 2),
          end = view.getUint16(ends + s * 2),
          delta = view.getInt16(deltas + s * 2),
          offset = view.getUint16(offsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const glyph =
            offset === 0
              ? (c + delta) & 0xffff
              : view.getUint16(offsets + s * 2 + offset + (c - start) * 2);
          if (glyph !== 0) points.add(c);
        }
      }
    } else if (format === 12) {
      for (let g = 0; g < view.getUint32(table + 12); g++) {
        const group = table + 16 + g * 12;
        for (let c = view.getUint32(group); c <= view.getUint32(group + 4); c++)
          points.add(c);
      }
    }
  }
  return points;
}
