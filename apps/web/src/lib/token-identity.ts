import { shortAddress } from "@pools/core";

/**
 * A token's own name or symbol as the chain reported it, or null when it
 * carries nothing to read: the contract's strings are arbitrary, and a launch
 * can name itself with an empty or all-blank string (production's `" "`).
 */
export function tokenText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}

/**
 * The line a token is known by: its name, then its symbol, then its short
 * address. Never a made-up placeholder; undefined only while the token itself
 * is not known yet.
 */
export function tokenLabel(identity: {
  name?: string | null;
  symbol?: string | null;
  token?: string | null;
}): string | undefined {
  return (
    tokenText(identity.name) ??
    tokenText(identity.symbol) ??
    (identity.token ? shortAddress(identity.token) : undefined)
  );
}

/**
 * The symbol a token's subline shows beside its label: only a named token's,
 * since a nameless one already reads its symbol as the label.
 */
export function tokenSubSymbol(identity: {
  name?: string | null;
  symbol?: string | null;
}): string | null {
  return tokenText(identity.name) ? tokenText(identity.symbol) : null;
}

/**
 * A launch list's one-line `Name (SYMBOL)`: the label, and the subline's
 * symbol in parentheses when there is one.
 */
export function tokenLine(identity: {
  name?: string | null;
  symbol?: string | null;
  token?: string | null;
}): string | undefined {
  const label = tokenLabel(identity);
  const symbol = tokenSubSymbol(identity);
  return symbol ? `${label} (${symbol})` : label;
}

/**
 * A search result's title, built as `name (symbol)` by the read API and the
 * local catalog alike, read through the same fallback as a token row: the
 * label, then the subline's symbol after a middle dot when there is one. A
 * title of any other shape is kept as it is.
 */
export function searchResultTitle(title: string, address: string): string {
  const parts = /^(.*) \(([^()]*)\)$/s.exec(title);
  if (!parts) return tokenText(title) ?? shortAddress(address);
  const identity = { name: parts[1], symbol: parts[2], token: address };
  const label = tokenLabel(identity)!;
  const symbol = tokenSubSymbol(identity);
  return symbol ? `${label} · ${symbol}` : label;
}
