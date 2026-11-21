import csv
import math
import pathlib
import struct
import sys
import zlib

source, destination = sys.argv[1:]
with pathlib.Path(source).open(encoding="utf-8-sig", newline="") as stream:
    rows = csv.reader(stream)
    next(rows)
    data = [(label, float(value)) for label, value in rows]
if not 1 <= len(data) <= 20 or not all(math.isfinite(value) for _, value in data):
    raise ValueError("Choose between one and twenty finite observations.")

width, height = 800, 400
pixels = bytearray([249, 250, 252]) * (width * height)
low = min(0, *(value for _, value in data))
high = max(0, *(value for _, value in data))
def y(value):
    return round(365 - (value - low) / (high - low or 1) * 330)

def rect(left, top, right, bottom, color):
    for row in range(top, bottom):
        offset = (row * width + left) * 3
        pixels[offset:offset + (right - left) * 3] = bytes(color) * (right - left)

origin = y(0)
rect(45, origin, 780, origin + 2, (42, 54, 73))
step = 720 / len(data)
for index, (_label, value) in enumerate(data):
    left = round(50 + index * step)
    top, bottom = sorted((origin, y(value)))
    rect(left, top, left + max(2, round(step * .72)), max(top + 1, bottom),
         (25, 100, 187) if value >= 0 else (176, 64, 63))

def png_chunk(kind, data_bytes):
    return struct.pack(">I", len(data_bytes)) + kind + data_bytes + struct.pack(">I", zlib.crc32(kind + data_bytes))

scanlines = b"".join(b"\0" + pixels[i:i + width * 3] for i in range(0, len(pixels), width * 3))
image = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
image += png_chunk(b"IDAT", zlib.compress(scanlines)) + png_chunk(b"IEND", b"")
pathlib.Path(destination).write_bytes(image)
print("Chart order: " + ", ".join(label for label, _ in data))
