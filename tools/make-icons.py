"""Generate Project Ledger PWA icons as PNGs, no third-party deps.

Usage: python3 tools/make-icons.py icons

Mark: three ledger rows (cyan / amber / green square + bar) on the app's dark panel.
"""
import struct, zlib, sys, os

BG = (0x0F, 0x12, 0x18)
ROWS = [(0x5E, 0xEA, 0xD4), (0xF5, 0xA6, 0x23), (0x4A, 0xDE, 0x80)]
BAR = (0x2A, 0x30, 0x3D)

SS = 3  # supersample factor per axis


def rr_cov(px, py, x0, y0, x1, y1, r):
    """Coverage-ish test: is point inside a rounded rect."""
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    dx, dy = px - cx, py - cy
    return dx * dx + dy * dy <= r * r


def render(size, pad_frac):
    """pad_frac: fraction of the canvas kept empty around the mark (maskable safe zone)."""
    S = size
    inner = S * (1 - 2 * pad_frac)
    ox = oy = S * pad_frac

    # three rows inside the inner box
    gap = inner * 0.14
    row_h = (inner - 2 * gap) / 3.0
    sq = row_h
    bar_h = row_h * 0.5
    bar_x0 = ox + sq + inner * 0.11
    bar_x1 = ox + inner
    shapes = []
    for i, color in enumerate(ROWS):
        top = oy + i * (row_h + gap)
        shapes.append((ox, top, ox + sq, top + sq, sq * 0.28, color))
        bt = top + (row_h - bar_h) / 2.0
        width = inner * (1.0 if i == 0 else (0.78 if i == 1 else 0.55))
        shapes.append((bar_x0, bt, min(bar_x1, bar_x0 + width), bt + bar_h, bar_h * 0.5, BAR))

    rows = bytearray()
    step = 1.0 / SS
    off = step / 2.0
    inv = 1.0 / (SS * SS)
    for y in range(S):
        rows.append(0)  # filter: none
        for x in range(S):
            acc = [0.0, 0.0, 0.0]
            for sy in range(SS):
                py = y + off + sy * step
                for sx in range(SS):
                    px = x + off + sx * step
                    col = BG
                    for (x0, y0, x1, y1, r, color) in shapes:
                        if x0 <= px <= x1 and y0 <= py <= y1 and rr_cov(px, py, x0, y0, x1, y1, r):
                            col = color
                    acc[0] += col[0]
                    acc[1] += col[1]
                    acc[2] += col[2]
            rows.append(int(acc[0] * inv + 0.5))
            rows.append(int(acc[1] * inv + 0.5))
            rows.append(int(acc[2] * inv + 0.5))
    return bytes(rows)


def write_png(path, size, raw):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)
    print(path, size, len(png), 'bytes')


out = sys.argv[1]
os.makedirs(out, exist_ok=True)
for name, size, pad in [
    ('icon-192.png', 192, 0.20),
    ('icon-512.png', 512, 0.20),
    ('icon-maskable-512.png', 512, 0.28),
    ('apple-touch-icon-180.png', 180, 0.20),
]:
    write_png(os.path.join(out, name), size, render(size, pad))
