"""Before/after grid: one row per consumer, one column per state, before over after."""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

S = os.path.dirname(os.path.abspath(__file__))
width = sys.argv[1]
out = sys.argv[2]
consumers = [
    ("screener-cta", "Screener: Trader leaderboard"),
    ("wallet-copy-trade", "Wallet: Copy trade"),
    ("pool-wallet-copy-trade", "Wallet (pool view): Copy trade"),
    ("preview-dialog-action", "Copy trade preview dialog action"),
    ("wallet-lookup", "Wallet lookup: Open wallet profile"),
    ("pool-trade", "Pool page: Trade on Pools"),
    ("set-wallet-submit", "Set my wallet dialog: submit"),
    ("pnl-share", "PnL card dialog: Share"),
    ("not-found", "404: back home"),
    ("preview-save-disabled", "Profile preview: Save (disabled)"),
]
states = ["rest", "hover", "active", "focus-visible", "disabled"]
scale = 1  # keep the 2x captures crisp
font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 24)
bold = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 24)


def load(phase, name, state):
    p = f"{S}/shots/{phase}/{width}/{name}-{state}.png"
    if not os.path.exists(p):
        return None
    im = Image.open(p).convert("RGB")
    return im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)


cells = {(n, s): (load("before", n, s), load("after", n, s)) for n, _ in consumers for s in states}
label_w = 440
tag_w = 100
col_w = {s: max([c[0].width for (n, st), c in cells.items() if st == s and c[0]] + [120]) for s in states}
row_h = {n: max([c[0].height for (nn, s), c in cells.items() if nn == n and c[0]] + [80]) for n, _ in consumers}
gap = 14
head = 50
W = label_w + tag_w + sum(col_w.values()) + gap * len(states) + gap
H = head + sum(row_h[n] * 2 + gap * 3 for n, _ in consumers)
img = Image.new("RGB", (W, H), (8, 8, 10))
d = ImageDraw.Draw(img)
x = label_w + tag_w
for s in states:
    d.text((x + 4, 9), s, fill=(154, 154, 164), font=bold)
    x += col_w[s] + gap
y = head
for n, label in consumers:
    d.line([(0, y - gap // 2 - 1), (W, y - gap // 2 - 1)], fill=(34, 34, 42))
    d.text((10, y + row_h[n] - 12), label, fill=(242, 242, 245), font=font)
    for i, phase in enumerate(["before", "after"]):
        yy = y + i * (row_h[n] + gap)
        d.text((label_w, yy + row_h[n] // 2 - 12), phase, fill=(122, 122, 133), font=font)
        x = label_w + tag_w
        for s in states:
            im = cells[(n, s)][i]
            if im:
                img.paste(im, (x, yy))
            x += col_w[s] + gap
    y += row_h[n] * 2 + gap * 3
img.save(out)
print(out, img.size)
