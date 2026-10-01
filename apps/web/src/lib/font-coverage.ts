/** A TrueType face's tables by tag, as offsets into the file. */
function fontTables(view: DataView): Map<string, number> {
  const tables = new Map<string, number>();
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    tables.set(
      String.fromCharCode(
        ...[0, 1, 2, 3].map((k) => view.getUint8(record + k)),
      ),
      view.getUint32(record + 8),
    );
  }
  return tables;
}

/**
 * Every code point the Unicode subtables of a face's `cmap` map to a glyph
 * (format 4 for the Basic Multilingual Plane, format 12 beyond it), with
 * the glyph it maps to.
 */
function eachMapping(
  view: DataView,
  visit: (codePoint: number, glyph: number) => void,
) {
  const cmap = fontTables(view).get("cmap");
  if (cmap === undefined) return;
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
          if (glyph !== 0) visit(c, glyph);
        }
      }
    } else if (format === 12) {
      for (let g = 0; g < view.getUint32(table + 12); g++) {
        const group = table + 16 + g * 12,
          start = view.getUint32(group),
          first = view.getUint32(group + 8);
        for (let c = start; c <= view.getUint32(group + 4); c++)
          visit(c, first + c - start);
      }
    }
  }
}
const fontView = (font: Uint8Array) =>
  new DataView(font.buffer, font.byteOffset, font.byteLength);

/**
 * The code points a TrueType face maps to a glyph, read from the Unicode
 * subtables of its `cmap` table (format 4 for the Basic Multilingual Plane,
 * format 12 beyond it). The share card strips what its own faces cannot draw
 * with this, rather than with a hand-kept range list: the renderer otherwise
 * fetches a stand-in face or emoji art from a third-party CDN mid-render.
 */
export function fontCodePoints(font: Uint8Array): Set<number> {
  const points = new Set<number>();
  eachMapping(fontView(font), (codePoint) => points.add(codePoint));
  return points;
}

/**
 * Each code point's advance width in a face, per 1000 em, from its `hmtx`
 * table. The card's renderer lays a line out as the sum of its glyphs'
 * advances, unkerned, so this measures a line exactly as the renderer will
 * before it is drawn, for any text the face covers.
 */
export function fontAdvances(font: Uint8Array): Map<number, number> {
  const view = fontView(font),
    tables = fontTables(view),
    head = tables.get("head"),
    hhea = tables.get("hhea"),
    hmtx = tables.get("hmtx"),
    advances = new Map<number, number>();
  if (head === undefined || hhea === undefined || hmtx === undefined)
    return advances;
  const unitsPerEm = view.getUint16(head + 18),
    metrics = view.getUint16(hhea + 34);
  eachMapping(view, (codePoint, glyph) =>
    advances.set(
      codePoint,
      (view.getUint16(hmtx + 4 * Math.min(glyph, metrics - 1)) * 1000) /
        unitsPerEm,
    ),
  );
  return advances;
}
