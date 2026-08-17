"""Cut Appy out of his white background and make the three colour variants.

His fur is white on a near-white background, so a global threshold would eat the
fluff. Instead: flood-fill the background from the border (only near-white,
connected pixels), then feather that mask so the fur tips stay soft.
Tint = recolour only the pale, unsaturated pixels (the fur); eyes, nose, paws and
the mouth keep their own colour.
"""
from PIL import Image, ImageFilter
from collections import deque
import os

SRC = r"C:/Users/sarah/OneDrive/Desktop/Quoteapp/client/public/assets"
OUT = r"C:/Users/sarah/OneDrive/Desktop/quotem-ai/assets/pet/appy"
os.makedirs(OUT, exist_ok=True)

STATES = {
    'idle':       'appy-idle.jpg',
    'blink_half': 'appy-blink-half.jpg',
    'blink':      'appy-blink-full.jpg',
    'happy':      'appy-happy.jpg',
    'talk':       'appy-talking.jpg',
    'open':       'appy mouthopen.jpg',
    'shocked':    'appy-shocked.jpg',
}
# (name, tint rgb or None) — tint is applied to the FUR only
COLOURS = {
    'snow':   None,
    'butter': (255, 205, 120),
    'lilac':  (206, 176, 246),
}
SIZE = 320

def cut(path):
    """His fur is 254 and the paper behind him is a flat 252 — so the cut has to
    be measured, not guessed. Take the background value from the corners, treat
    ONLY that value (±1) as paper, flood it from the border (so anything walled
    in by fur stays), then feather so the wisps keep their softness."""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    bgv = sorted(sum(c) // 3 for c in corners)[len(corners) // 2]
    lo, hi = bgv - 3, bgv + 1        # -3 also takes out the faint ground shadow; his lit fur is 254+, so it stays
    def paper(p):
        r, g, b = p
        return lo <= r <= hi and lo <= g <= hi and lo <= b <= hi
    bg = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not bg[y * w + x] and paper(px[x, y]): bg[y * w + x] = 1; q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not bg[y * w + x] and paper(px[x, y]): bg[y * w + x] = 1; q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and paper(px[nx, ny]):
                bg[ny * w + nx] = 1; q.append((nx, ny))
    # JPEG noise leaves specks of "not paper" all over the background: keep only
    # the one big island that is actually him, drop every crumb around it.
    keep = bytearray(w * h)
    best, bestlen = None, 0
    seen = bytearray(w * h)
    for sy in range(h):
        for sx in range(w):
            i0 = sy * w + sx
            if bg[i0] or seen[i0]: continue
            comp = []
            seen[i0] = 1; q2 = deque([(sx, sy)])
            while q2:
                x, y = q2.popleft(); comp.append(y * w + x)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    j = ny * w + nx
                    if 0 <= nx < w and 0 <= ny < h and not bg[j] and not seen[j]:
                        seen[j] = 1; q2.append((nx, ny))
            if len(comp) > bestlen: best, bestlen = comp, len(comp)
    for i in best: keep[i] = 1
    alpha = Image.frombytes('L', (w, h), bytes(255 if v else 0 for v in keep))
    # the jpeg leaves 8x8 steps along his outline: blur-and-threshold rounds the
    # silhouette off, then a dilate + soft blur gives the fur its tips back
    alpha = alpha.filter(ImageFilter.GaussianBlur(2.6)).point(lambda v: 255 if v > 116 else 0)
    alpha = alpha.filter(ImageFilter.MaxFilter(3))
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.2))
    out = im.convert('RGBA'); out.putalpha(alpha)
    # the soft grey puddle he casts on the paper is part of the picture, not part
    # of him — it tints into a gold/purple pool otherwise. His feet are pink, so
    # colour tells them apart from the shadow.
    o = out.load()
    for y in range(int(h * 0.86), h):
        for x in range(w):
            r, g, b, a = o[x, y]
            if a and max(r, g, b) - min(r, g, b) < 14 and (r + g + b) / 3 > 205:
                o[x, y] = (r, g, b, 0)
    box = out.getbbox()
    return out.crop(box)

def tint(im, rgb):
    if rgb is None: return im
    px = im.load(); w, h = im.size
    tr, tg, tb = rgb
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0: continue
            lum = (r * 299 + g * 587 + b * 114) // 1000
            sat = max(r, g, b) - min(r, g, b)
            if a > 200 and lum > 150 and sat < 60:                # the fur (and its shading), not the feathered edge
                k = lum / 255
                px[x, y] = (int(tr * k), int(tg * k), int(tb * k), a)
    return im

for state, fn in STATES.items():
    base = cut(os.path.join(SRC, fn))
    # square canvas so every state lines up when they swap
    side = max(base.size)
    sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    sq.paste(base, ((side - base.size[0]) // 2, side - base.size[1]))   # sit him on the floor
    sq = sq.resize((SIZE, SIZE), Image.LANCZOS)
    for cname, rgb in COLOURS.items():
        im = tint(sq.copy(), rgb)
        p = os.path.join(OUT, f"{cname}_{state}.png")
        im.save(p, optimize=True)
        print(cname, state, im.size, os.path.getsize(p) // 1024, 'KB')
