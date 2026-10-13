"""Gemeinsame Helfer fuer die Bake-Pipeline des Leipzig-3D-Modells.

Alle Rohdaten liegen im Quellformat vor (CityJSON, GeoTIFF, GeoJSON, PNG-Raster)
und werden hier in kompakte, WebGL-freundliche Binaerdateien umgewandelt.

Lokales Koordinatensystem des Modells:
    x = Easting  (EPSG:25833) - ORIGIN_X   -> +x = Osten
    z = -(Northing (EPSG:25833) - ORIGIN_Y) -> -z = Norden (three.js-Konvention)
    y = Hoehe (NHN, Meter) - ORIGIN_Z
"""

from __future__ import annotations

import gzip
import json
import math
import os
import struct
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# Pfade
# --------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data"


def raw_dir() -> Path:
    """Verzeichnis mit den entpackten Rohdaten (Tiles der Stadt Leipzig)."""
    candidates = []
    if os.environ.get("LEIPZIG_RAW"):
        candidates.append(Path(os.environ["LEIPZIG_RAW"]))
    candidates += [
        ROOT / "data" / "raw" / "leipzig",
        Path("/tmp/bridge/data/leipzig"),
    ]
    for c in candidates:
        if (c / "cityjson").is_dir():
            return c
    raise SystemExit(
        "Rohdaten nicht gefunden. Bitte zuerst die Quellen nach data/raw/leipzig "
        "laden (siehe docs/DATENQUELLEN.md) oder LEIPZIG_RAW setzen."
    )


# --------------------------------------------------------------------------
# Gebiet
# --------------------------------------------------------------------------

# 4 x 4 km Kernstadt (Leipzig-Mitte, Innenstadtring, angrenzende Viertel),
# exakt die vier 2-km-Kacheln, die die Quelle liefert.
AREA = (316000.0, 5688000.0, 320000.0, 5692000.0)  # x0, y0, x1, y1 (EPSG:25833)
ORIGIN_X = 318000.0
ORIGIN_Y = 5690000.0
ORIGIN_Z = 100.0
SIZE_M = 4000.0

TILES = ["33316_5688_2_sn", "33316_5690_2_sn", "33318_5688_2_sn", "33318_5690_2_sn"]

CHUNK_M = 250.0          # Kantenlaenge der Gebietskacheln (Ladeeinheit)
CHUNKS_PER_SIDE = int(SIZE_M / CHUNK_M)   # 16 -> 256 Kacheln


def to_local(x: float, y: float, z: float = 0.0) -> tuple[float, float, float]:
    return (x - ORIGIN_X, z - ORIGIN_Z, -(y - ORIGIN_Y))


def chunk_of(lx: float, lz: float) -> int:
    """Kachelindex 0..255 aus lokalen Koordinaten (ausserhalb wird geklemmt)."""
    ci = min(CHUNKS_PER_SIDE - 1, max(0, int((lx + SIZE_M / 2) // CHUNK_M)))
    cj = min(CHUNKS_PER_SIDE - 1, max(0, int((lz + SIZE_M / 2) // CHUNK_M)))
    return cj * CHUNKS_PER_SIDE + ci


def chunk_origin(index: int) -> tuple[float, float]:
    ci = index % CHUNKS_PER_SIDE
    cj = index // CHUNKS_PER_SIDE
    return (-SIZE_M / 2 + ci * CHUNK_M, -SIZE_M / 2 + cj * CHUNK_M)


# --------------------------------------------------------------------------
# Farbe
# --------------------------------------------------------------------------


def hex_color(s: str) -> tuple[int, int, int] | None:
    if not s or not isinstance(s, str):
        return None
    s = s.strip().lstrip("#")
    try:
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        if len(s) != 6:
            return None
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return None


def linear_to_srgb(c: float) -> float:
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def jitter(color: tuple[int, int, int], seed: int, amount: float = 0.06) -> tuple[int, int, int]:
    """Deterministische, kleine Farbvariation pro Gebaeude (macht Flaechen lebendig)."""
    rnd = hash01(seed)
    f = 1.0 + (rnd - 0.5) * 2.0 * amount
    g = hash01(seed * 7919 + 13)
    tint = (g - 0.5) * 0.06
    out = []
    for i, c in enumerate(color):
        v = c / 255.0 * f + (tint if i == 0 else -tint * 0.5)
        out.append(int(max(0, min(255, round(v * 255)))))
    return tuple(out)  # type: ignore[return-value]


def hash01(n: int) -> float:
    n = (n * 2654435761) & 0xFFFFFFFF
    n ^= n >> 15
    n = (n * 2246822519) & 0xFFFFFFFF
    n ^= n >> 13
    n = (n * 3266489917) & 0xFFFFFFFF
    n ^= n >> 16
    return n / 0xFFFFFFFF


def pick(seq, seed: int):
    return seq[int(hash01(seed) * len(seq)) % len(seq)]


# --------------------------------------------------------------------------
# Schreiben
# --------------------------------------------------------------------------


def write_gz(path: Path, data: bytes, level: int = 9) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.GzipFile(filename="", mode="wb", fileobj=open(path, "wb"), compresslevel=level) as fh:
        fh.write(data)
    size = path.stat().st_size / 1e6
    print(f"  -> {path.relative_to(ROOT)}  ({size:.2f} MB)")


def write_json_gz(path: Path, obj, level: int = 9) -> None:
    raw = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    print(f"  json {len(raw)/1e6:.2f} MB")
    write_gz(path, raw, level)


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"  -> {path.relative_to(ROOT)}  ({path.stat().st_size/1e6:.2f} MB)")


# --------------------------------------------------------------------------
# Vektor-Geometrie
# --------------------------------------------------------------------------


def ring_area(ring) -> float:
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        s += x1 * y2 - x2 * y1
    return s / 2.0


def polylabel_lite(ring) -> tuple[float, float]:
    """Grob ausreichender Labelpunkt: Flaechenschwerpunkt, sonst Mittel der Punkte."""
    a = ring_area(ring)
    if abs(a) < 1e-9:
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return (sum(xs) / len(xs), sum(ys) / len(ys))
    cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i][0], ring[i][1]
        x2, y2 = ring[(i + 1) % n][0], ring[(i + 1) % n][1]
        cross = x1 * y2 - x2 * y1
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
    return (cx / (6 * a), cy / (6 * a))


def simplify_ring(ring, tol: float):
    """Douglas-Peucker (iterativ) - haelt die Wasserlinien klein."""
    if len(ring) < 4:
        return ring
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        x0, y0 = ring[i0][0], ring[i0][1]
        x1, y1 = ring[i1][0], ring[i1][1]
        dx, dy = x1 - x0, y1 - y0
        norm = math.hypot(dx, dy)
        best, best_i = -1.0, -1
        for i in range(i0 + 1, i1):
            px, py = ring[i][0], ring[i][1]
            if norm < 1e-12:
                d = math.hypot(px - x0, py - y0)
            else:
                d = abs(dy * px - dx * py + x1 * y0 - y1 * x0) / norm
            if d > best:
                best, best_i = d, i
        if best > tol:
            keep[best_i] = True
            stack.append((i0, best_i))
            stack.append((best_i, i1))
    return [p for p, k in zip(ring, keep) if k]


# --------------------------------------------------------------------------
# Binaerpuffer
# --------------------------------------------------------------------------


class Buffer:
    """Einfacher little-endian Byte-Puffer."""

    def __init__(self):
        self.parts: list[bytes] = []
        self.length = 0

    def raw(self, b: bytes):
        self.parts.append(b)
        self.length += len(b)

    def u8(self, *v):
        self.raw(struct.pack("<" + "B" * len(v), *v))

    def u16(self, *v):
        self.raw(struct.pack("<" + "H" * len(v), *v))

    def i16(self, *v):
        self.raw(struct.pack("<" + "h" * len(v), *v))

    def u32(self, *v):
        self.raw(struct.pack("<" + "I" * len(v), *v))

    def f32(self, *v):
        self.raw(struct.pack("<" + "f" * len(v), *v))

    def array(self, fmt: str, values) -> None:
        import array as _array

        a = _array.array(fmt, values)
        if sys.byteorder == "big":  # pragma: no cover
            a.byteswap()
        self.raw(a.tobytes())

    def getvalue(self) -> bytes:
        return b"".join(self.parts)


def log(*a):
    print(*a, flush=True)
