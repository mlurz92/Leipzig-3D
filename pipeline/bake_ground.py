#!/usr/bin/env python3
"""Bake Bodenbedeckung -> public/data/ground.jpg (4096^2, ~1 m/px) + ground_aux.png (2048^2)

Quellen pro 2-km-Kachel (alle Raster mit Zeile 0 = Norden):
  landcover  4096^2  Klassen (Wald, Wasser, Bahn, Weg, Strasse ...)
  surface    2048^2  R=Belag/Parken, G=Bearing, B/A=Streckenoffset
  markings   2048^2  R/A=Markierungszeile, G=Fahrstreifen-Bits, B=Distanz zur Fahrbahnmitte
  edges      2048^2  R=Kantenabstand Strasse, G=Kantenabstand Wiese
  sport      2048^2  R/G=Sportplatzzeilen, B=exakter Umriss
  ndvi/svf   1024^2  Gruenintensitaet / Himmelsichtbarkeit
"""

from __future__ import annotations

import json
import math
import time

import numpy as np
from PIL import Image, ImageDraw

import common as C

N = 4096                     # Ausgabetextur (1 m/px)
RES = C.SIZE_M / N           # 0,9766 m/px
N_CLS = 8192                 # Klassenraster (0,488 m/px)
N_C = 2048                   # Hilfsraster (1,95 m/px)

CLS_COLOR = {
    0: (118, 116, 108),      # background
    1: (172, 164, 108),      # farmland
    2: (56, 80, 46),         # forest
    3: (86, 112, 62),        # copse
    4: (152, 148, 140),      # builtup (Hoefe, Hinterland)
    5: (108, 104, 100),      # railway
    6: (176, 170, 156),      # path
    7: (84, 86, 90),         # road
    8: (38, 60, 70),         # water
}
SURFACE_COLOR = {
    1: (78, 79, 83),         # asphalt
    2: (152, 150, 144),      # concrete
    3: (168, 160, 146),      # paving
    4: (140, 132, 120),      # sett
    5: (150, 138, 116),      # unpaved
    6: (104, 122, 76),       # grass
}
SPORT_COLOR = {
    0: (110, 130, 70), 1: (86, 126, 62), 2: (74, 122, 56), 3: (176, 88, 66),
    4: (182, 118, 84), 5: (214, 200, 152), 6: (140, 140, 140), 7: (128, 100, 88),
}


def tile_offset(name: str) -> tuple[int, int]:
    parts = name.split("_")
    return int(parts[0][2:]) * 1000, int(parts[1]) * 1000


def noise(shape, octaves=(96, 384, 1536), seed=7) -> np.ndarray:
    """Weiches Mehrskalenrauschen in [0,1] - laesst Flaechen nicht tot wirken."""
    rng = np.random.default_rng(seed)
    h, w = shape
    out = np.zeros(shape, dtype=np.float32)
    amp, total = 1.0, 0.0
    for o in octaves:
        small = rng.random((o, o)).astype(np.float32)
        up = np.asarray(
            Image.fromarray((small * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC),
            dtype=np.float32,
        ) / 255.0
        out += up * amp
        total += amp
        amp *= 0.55
    return out / total


def main() -> None:
    t0 = time.time()
    raw = C.raw_dir()
    dlm = raw / "dlm"
    out = C.OUT
    out.mkdir(parents=True, exist_ok=True)

    cls = np.zeros((N_CLS, N_CLS), dtype=np.uint8)
    big = {}                      # 2048er-Raster -> 4096er Gesamtbild
    for key, size in (("surface", N), ("markings", N), ("edges", N), ("sport", N)):
        big[key] = np.zeros((size, size, 4 if key != "edges" else 2), dtype=np.uint8)
    small = {k: np.zeros((N_C, N_C), dtype=np.float32) for k in ("ndvi", "svf")}

    for tile in C.TILES:
        x0, y0 = tile_offset(tile)
        # Klassenraster: 4096 px pro Kachel bei 2000 m
        c0 = int(round((x0 - C.AREA[0]) / (C.SIZE_M / N_CLS)))
        r0 = int(round((C.AREA[3] - (y0 + 2000)) / (C.SIZE_M / N_CLS)))
        cls[r0:r0 + 4096, c0:c0 + 4096] = np.asarray(Image.open(dlm / f"landcover_{tile}.png"))[:4096, :4096]
        # 2048er-Raster
        c1 = int(round((x0 - C.AREA[0]) / RES))
        r1 = int(round((C.AREA[3] - (y0 + 2000)) / RES))
        big["surface"][r1:r1 + 2048, c1:c1 + 2048] = np.asarray(
            Image.open(dlm / f"surface_{tile}.png")).reshape(2048, 2048, 4)
        big["markings"][r1:r1 + 2048, c1:c1 + 2048] = np.asarray(
            Image.open(dlm / f"markings_{tile}.png")).reshape(2048, 2048, 4)
        big["edges"][r1:r1 + 2048, c1:c1 + 2048] = np.asarray(
            Image.open(dlm / f"edges_{tile}.png")).reshape(2048, 2048, 2)
        big["sport"][r1:r1 + 2048, c1:c1 + 2048] = np.asarray(
            Image.open(dlm / f"sport_{tile}.png")).reshape(2048, 2048, 4)
        c2 = int(round((x0 - C.AREA[0]) / (C.SIZE_M / N_C)))
        r2 = int(round((C.AREA[3] - (y0 + 2000)) / (C.SIZE_M / N_C)))
        small["ndvi"][r2:r2 + 1024, c2:c2 + 1024] = np.asarray(
            Image.open(dlm / f"ndvi_{tile}.png"), dtype=np.float32)
        small["svf"][r2:r2 + 1024, c2:c2 + 1024] = np.asarray(
            Image.open(dlm / f"svf_{tile}.png"), dtype=np.float32)
    C.log("Raster zusammengesetzt")

    # Klassenraster auf Zielaufloesung (naechster Nachbar)
    landcover = np.asarray(Image.fromarray(cls).resize((N, N), Image.NEAREST))
    surface = big["surface"]
    markings = big["markings"]
    edges = big["edges"]
    sport = big["sport"]
    svf = np.asarray(Image.fromarray(np.clip(small["svf"], 0, 255).astype(np.uint8)).resize((N, N), Image.BILINEAR), dtype=np.float32)
    ndvi = np.asarray(Image.fromarray(np.clip(small["ndvi"], 0, 255).astype(np.uint8)).resize((N, N), Image.BILINEAR), dtype=np.float32)

    # ------------------------------------------------------------ Basisfarben
    img = np.zeros((N, N, 3), dtype=np.float32)
    for k, col in CLS_COLOR.items():
        img[landcover == k] = col

    n1 = noise((N, N))
    grain = np.random.default_rng(3).random((N, N)).astype(np.float32) - 0.5

    # ------------------------------------------------------------ Belaege
    road_class = surface[:, :, 0] & 7
    walk_class = (surface[:, :, 0] >> 3) & 7
    park_class = (surface[:, :, 0] >> 6) & 3
    asphalt = np.zeros((N, N), dtype=bool)
    for k, col in SURFACE_COLOR.items():
        m = road_class == k
        if m.any():
            img[m] = np.array(col, dtype=np.float32) * (0.94 + 0.12 * n1[m, None])
            asphalt |= m
    for k in (3, 4):
        m = walk_class == k
        if m.any():
            img[m] = np.array(SURFACE_COLOR[k], dtype=np.float32) * (0.95 + 0.10 * n1[m, None])
    m = park_class > 0
    if m.any():
        img[m] = np.array((70, 72, 76), dtype=np.float32) * (0.95 + 0.10 * n1[m, None])
        asphalt |= m
    for k, col in SPORT_COLOR.items():
        m = sport[:, :, 0] == k + 1
        if m.any():
            img[m] = np.array(col, dtype=np.float32) * (0.95 + 0.10 * n1[m, None])
    m = sport[:, :, 2] > 200
    if m.any():
        img[m] = np.array((236, 236, 232), dtype=np.float32)

    # ------------------------------------------------------------ Markierungen
    centre = (markings[:, :, 1] & 4) > 0
    dist_mid = (markings[:, :, 2].astype(np.int16) - 128) / 20.0
    img[centre & (np.abs(dist_mid) < 0.28)] = np.array((228, 228, 224), dtype=np.float32)
    cycle = (markings[:, :, 1] & 1) > 0
    img[cycle] *= np.array((1.0, 0.94, 0.91), dtype=np.float32)

    img_u8 = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(img_u8)
    n_mark = 0
    for tile in C.TILES:
        meta = json.loads((dlm / f"markings_{tile}.json").read_text())
        tx, ty = tile_offset(tile)
        for cx, cy, ang, hl, hw, kind in meta["markings"]:
            px = (tx + cx - C.AREA[0]) / RES
            py = (C.AREA[3] - (ty + cy)) / RES
            if not (2 <= px < N - 2 and 2 <= py < N - 2):
                continue
            ca, sa = math.cos(ang), math.sin(ang)
            ux, uy = ca, -sa                      # quer zur Fahrbahn
            vx, vy = sa, ca                       # laengs der Fahrbahn
            n_mark += 1

            def corner(du: float, dv: float) -> tuple[float, float]:
                return (px + ux * du + vx * dv, py + uy * du + vy * dv)

            if kind == 1:                         # Fussgaengerueberweg
                n_stripes = max(2, int(round(2 * hl)))
                step = 2 * hl / n_stripes
                half = min(0.28, step * 0.35)
                for i in range(n_stripes):
                    du = -hl + (i + 0.5) * step
                    draw.polygon(
                        [corner(du - half, -hw), corner(du + half, -hw),
                         corner(du + half, hw), corner(du - half, hw)],
                        fill=(232, 232, 228),
                    )
            else:                                 # Haltlinie / Furt
                col = (226, 226, 222) if kind == 3 else (198, 198, 192)
                draw.polygon([corner(-hl, -hw), corner(hl, -hw), corner(hl, hw), corner(-hl, hw)], fill=col)

    # Straßenbahngleise
    for tile in C.TILES:
        gf = dlm / f"tram_{tile}.geojson"
        if not gf.exists():
            continue
        for f in json.loads(gf.read_text())["features"]:
            if f["properties"].get("k") != "track":
                continue
            pts = [((x - C.AREA[0]) / RES, (C.AREA[3] - y) / RES) for x, y in f["geometry"]["coordinates"]]
            if len(pts) > 1:
                draw.line(pts, fill=(74, 72, 70), width=2, joint="curve")
    C.log(f"  {n_mark} Markierungen eingezeichnet")
    img = np.asarray(img_u8, dtype=np.float32)

    # ------------------------------------------------------------ Kanten, Gruen
    d_road = (edges[:, :, 0].astype(np.float32) - 128) / 20.0
    img[np.abs(d_road) < 0.22] *= 0.87        # Bordstein
    img[edges[:, :, 1] > 130] *= 0.975        # Wiesenkante
    veg = np.isin(landcover, (2, 3))
    t = np.clip(ndvi / 110.0, 0, 1) * 0.5
    img[veg] = img[veg] * (1 - t[veg, None]) + np.array((58, 92, 44), dtype=np.float32) * t[veg, None]

    # ------------------------------------------------------------ Verschattung
    img *= (0.62 + 0.38 * np.clip(svf / 255.0, 0, 1))[:, :, None]
    img *= (1.0 + 0.05 * grain)[:, :, None]
    speck = np.random.default_rng(5).random((N, N)).astype(np.float32)
    img[asphalt] *= (1.0 + 0.06 * (speck[asphalt] - 0.5))[:, None]

    img = np.clip(img, 0, 255).astype(np.uint8)
    Image.fromarray(img).save(out / "ground.jpg", quality=85, optimize=True, subsampling=1)

    # ------------------------------------------------------------ Hilfstextur
    water = landcover == 8
    aux = np.zeros((N_C, N_C, 4), dtype=np.uint8)
    aux[:, :, 0] = np.where(water.reshape(N_C, 2, N_C, 2).any(axis=(1, 3)), 255, 0)
    aux[:, :, 1] = np.clip(
        np.asarray(Image.fromarray(road_class.astype(np.uint8)).resize((N_C, N_C), Image.NEAREST)), 0, 7) * 36
    aux[:, :, 2] = np.clip(255 - small["svf"], 0, 255).astype(np.uint8)
    aux[:, :, 3] = np.where(
        np.asarray(Image.fromarray((landcover == 2).astype(np.uint8)).resize((N_C, N_C), Image.NEAREST)) > 0, 255, 0)
    Image.fromarray(aux).save(out / "ground_aux.png", optimize=True)

    np.save("/tmp/water_mask.npy", water)
    np.save("/tmp/landcover.npy", landcover)

    C.log(
        f"ground.jpg {(out/'ground.jpg').stat().st_size/1e6:.2f} MB | "
        f"ground_aux.png {(out/'ground_aux.png').stat().st_size/1e6:.2f} MB | "
        f"Wasser {water.mean()*100:.1f} % | {time.time()-t0:.1f}s"
    )


if __name__ == "__main__":
    main()
