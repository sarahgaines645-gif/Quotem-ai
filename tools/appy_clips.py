"""Turn Appy's video into animation clips the pet engine can play.

Sarah, 17 Aug: "I want it to move… gives him hands that can open and move around
like he would in a film." She already had that: `appy-video.mp4` in the app —
6 seconds of Appy jumping, waving his little hands, tumbling and cheering.

This takes that film, cuts Appy off his white paper frame by frame (same matte as
tools/cut_appy.py: measure the paper value, flood it from the border, keep the
biggest island, smooth the jpeg steps, feather the fur), keeps every frame on one
shared bounding box so he doesn't jitter, and writes one sprite sheet per action
plus a manifest. The engine plays a sheet at 12fps and swaps sheets as his mood
changes — that is how a video game plays a character.

Re-run it whenever there is new footage: put the mp4 in SRC_VIDEO, name the
frame ranges in CLIPS (frame numbers are 12fps positions, 1-based, inclusive).
"""
from PIL import Image, ImageFilter
from collections import deque
import json, os, subprocess, sys, glob, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_VIDEO = os.environ.get('APPY_VIDEO', r"C:/Users/sarah/OneDrive/Desktop/Quoteapp/client/public/assets/appy-video.mp4")
OUT = os.path.join(ROOT, 'assets', 'pet', 'appy', 'clips')
TMP = os.path.join(ROOT, '.appy-frames')
FPS = 12
FRAME = 200          # each frame in the sheet, px
COLS = 6

# what is in her 6 seconds, at 12fps
CLIPS = {
    'idle':   (61, 72),    # calm, breathing, a blink
    'blink':  (4, 8),      # eyes close and open
    'talk':   (49, 60),    # mouth going, happy
    'hands':  (9, 20),     # mouth opens and his little hands come up and wave
    'cheer':  (41, 48),    # lands with both arms up, mouth wide — the celebration
    'tumble': (25, 40),    # rolls right over — how a fluffball crosses a room
}

def ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which('ffmpeg') or sys.exit('no ffmpeg — pip install imageio-ffmpeg')

def extract():
    if os.path.isdir(TMP): shutil.rmtree(TMP)
    os.makedirs(TMP)
    subprocess.run([ffmpeg(), '-i', SRC_VIDEO, '-vf', f'fps={FPS}', '-q:v', '2',
                    os.path.join(TMP, '%03d.png'), '-hide_banner', '-loglevel', 'error'], check=True)
    return sorted(glob.glob(os.path.join(TMP, '*.png')))

def matte(path):
    """Cut him off the paper. Returns RGBA at the frame's own size."""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    px = im.load()
    corners = [px[2, 2], px[w - 3, 2], px[2, h - 3], px[w - 3, h - 3]]
    bgv = sorted(sum(c) // 3 for c in corners)[len(corners) // 2]
    lo, hi = bgv - 3, bgv + 1
    def paper(p):
        r, g, b = p
        return lo <= r <= hi and lo <= g <= hi and lo <= b <= hi
    bg = bytearray(w * h); q = deque()
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
    # keep the biggest island (jpeg noise leaves crumbs everywhere)
    seen = bytearray(w * h); best, bestlen = None, 0
    for sy in range(h):
        for sx in range(w):
            i0 = sy * w + sx
            if bg[i0] or seen[i0]: continue
            comp = []; seen[i0] = 1; q2 = deque([(sx, sy)])
            while q2:
                x, y = q2.popleft(); comp.append(y * w + x)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy; j = ny * w + nx
                    if 0 <= nx < w and 0 <= ny < h and not bg[j] and not seen[j]:
                        seen[j] = 1; q2.append((nx, ny))
            if len(comp) > bestlen: best, bestlen = comp, len(comp)
    keep = bytearray(w * h)
    for i in best: keep[i] = 1
    a = Image.frombytes('L', (w, h), bytes(255 if v else 0 for v in keep))
    a = a.filter(ImageFilter.GaussianBlur(2.2)).point(lambda v: 255 if v > 116 else 0)
    a = a.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
    out = im.convert('RGBA'); out.putalpha(a)
    # his cast shadow belongs to the picture, not to him
    o = out.load()
    for y in range(int(h * 0.86), h):
        for x in range(w):
            r, g, b, al = o[x, y]
            if al and max(r, g, b) - min(r, g, b) < 14 and (r + g + b) / 3 > 205:
                o[x, y] = (r, g, b, 0)
    return out

def main():
    frames = extract()
    print(f"{len(frames)} frames at {FPS}fps")
    need = sorted({i for a, b in CLIPS.values() for i in range(a, b + 1)})
    cut = {}
    for i in need:
        if i - 1 >= len(frames): continue
        cut[i] = matte(frames[i - 1])
        print('.', end='', flush=True)
    print()
    os.makedirs(OUT, exist_ok=True)
    manifest = {'fps': FPS, 'frame': FRAME, 'cols': COLS, 'clips': {}}
    for name, (a, b) in CLIPS.items():
        ims = [cut[i] for i in range(a, b + 1) if i in cut]
        if not ims: continue
        # ONE bounding box for the whole clip: he must not jitter between frames
        boxes = [im.getbbox() for im in ims]
        L = min(x[0] for x in boxes); T = min(x[1] for x in boxes)
        R = max(x[2] for x in boxes); B = max(x[3] for x in boxes)
        side = max(R - L, B - T)
        cx = (L + R) // 2
        box = (cx - side // 2, B - side, cx - side // 2 + side, B)   # feet on the bottom edge
        rows = (len(ims) + COLS - 1) // COLS
        sheet = Image.new('RGBA', (COLS * FRAME, rows * FRAME), (0, 0, 0, 0))
        for k, im in enumerate(ims):
            f = im.crop(box).resize((FRAME, FRAME), Image.LANCZOS)
            sheet.paste(f, ((k % COLS) * FRAME, (k // COLS) * FRAME))
        p = os.path.join(OUT, name + '.webp')
        sheet.save(p, quality=90, method=6)
        manifest['clips'][name] = {'frames': len(ims), 'rows': rows}
        print(f"{name}: {len(ims)} frames, {os.path.getsize(p)//1024}KB -> {p}")
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(manifest, fh, indent=2)
    shutil.rmtree(TMP, ignore_errors=True)
    print('manifest written')

if __name__ == '__main__':
    main()
