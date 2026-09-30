export function ipv6ClientKey(address: string): string {
  let text = address.toLowerCase();
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text =
      text.slice(0, -tail[1].length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups = [
    ...left,
    ...Array(rest === undefined ? 0 : missing).fill("0"),
    ...right,
  ].map((group) => group.replace(/^0+(?=.)/, "") || "0");
  return `${groups.slice(0, 4).join(":")}::/64`;
}
