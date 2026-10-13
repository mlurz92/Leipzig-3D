#!/usr/bin/env python3
"""Bake Requisiten -> public/data/props.bin.gz + props.json

Alles, was das Stadtbild neben Gebaeuden und Baeumen ausmacht, wird zu
geometrischen Gruppen zusammengefasst (statt 9000 Einzelobjekte):

  wall       DLM walls        Linienzuege als Kaesten
  hedge      DLM lowveg       Hecken, Baumreihen
  bridge     DLM bridge       Brueckendecks als Prismen
  monument   DLM monuments    Sockel, Becken
  mast       DLM structures   Maste, Antennen, Schornsteine, Tuerme
  platform   DLM platform     Bahnsteigkanten
  stairs     DLM stairs       Stufenfolgen
  ballast    DLM railarea     Schotterflaechen
  shed       DLM smallbuild   Schuppen, Garagen, Kioske
  furniture  DLM furniture    Baenke, Tische, Abfall, Pfosten, Signale

Format je Teil: u32 nVerts, u32 nTris, f32 ox, oy, oz, dann
    i16 pos[n*3]  (Zentimeter relativ zum jeweiligen Ursprung)
    u8  col[n*4]
    u16 idx[nt*3]
Gerechnet wird in Weltkoordinaten: x nach Osten, z nach Sueden, y Hoehe NN.
Die Hoehen kommen aus dem gebackenen Gelaenderaster (terrain.bin.gz).
"""

from __future__ import annotations

import gzip
import json
import math
import time

import numpy as np

import common as C

COL = {
    "wall": (172, 164, 150),
    "hedge": (58, 84, 46),
    "treerow": (64, 92, 52),
    "bridge": (152, 150, 144),
    "bridge_rail": (120, 118, 114),
    "monument": (170, 166, 156),
    "basin": (62, 88, 104),
    "mast": (124, 126, 128),
    "platform": (178, 176, 172),
    "stairs": (170, 166, 158),
    "ballast": (98, 90, 84),
    "shed": (152, 146, 134),
    "shed_roof": (98, 94, 90),
    "metal": (94, 98, 102),
    "wood": (130, 102, 72),
    "dark": (62, 64, 66),
    "stone": (178, 174, 164),
    "red": (150, 62, 52),
    "green": (74, 98, 68),
}


CELL = 500.0                       # Kantenlaenge der Requisitenkacheln (m)
CELLS = int(C.SIZE_M / CELL)       # 8 x 8 Felder


def cell_of(ex: float, ny: float) -> int:
    """Feldindex aus UTM-Koordinaten."""
    lx = ex - C.ORIGIN_X + C.SIZE_M / 2
    lz = -(ny - C.ORIGIN_Y) + C.SIZE_M / 2
    ci = min(CELLS - 1, max(0, int(lx // CELL)))
    cj = min(CELLS - 1, max(0, int(lz // CELL)))
    return cj * CELLS + ci


def cell_origin(index: int) -> tuple[float, float]:
    ci, cj = index % CELLS, index // CELLS
    return (-C.SIZE_M / 2 + ci * CELL, -C.SIZE_M / 2 + cj * CELL)


class Props:
    """Sammelt Dreiecke je Gruppe und 250-m-Kachel."""

    def __init__(self, ground):
        self.chunks: dict[int, dict] = {}
        self.ground = ground

    def group(self, ex: float, ny: float, name: str):
        """Puffer der Gruppe.

        Die Stadt wird in 500-m-Felder geteilt: klein genug, dass die
        i16-Versaetze passen, gross genug fuer wenige Zeichenaufrufe.
        """
        cid = cell_of(ex, ny)
        c = self.chunks.get(cid)
        if c is None:
            ox, oz = cell_origin(cid)
            c = self.chunks[cid] = {"i": cid, "ox": ox, "oz": oz, "groups": {}}
        g = c["groups"].get(name)
        if g is None:
            g = c["groups"][name] = {"pos": [], "col": [], "idx": []}
        return g

    # ---------------------------------------------------------------- Primitive
    def quad(self, x: float, z: float, name: str, a, b, c, d, color):
        g = self.group(x, z, name)
        base = len(g["pos"])
        for p in (a, b, c, d):
            g["pos"].append(p)
            g["col"].append(color)
        g["idx"] += [base, base + 1, base + 2, base, base + 2, base + 3]

    def box(self, x: float, z: float, name: str, cx, cy, cz, sx, sy, sz, yaw, color, top=None):
        """Kasten, dessen Grundflaeche bei cy liegt (cy = Unterkante)."""
        ca, sa = math.cos(yaw), math.sin(yaw)
        hx, hy, hz = sx / 2, sy / 2, sz / 2

        def p(dx, dy, dz):
            return (cx + dx * ca - dz * sa, cy + dy + hy, cz + dx * sa + dz * ca)

        t = top if top is not None else color
        bottom = (color[0] // 2, color[1] // 2, color[2] // 2)
        a, b = p(-hx, -hy, -hz), p(hx, -hy, -hz)
        c, d = p(hx, -hy, hz), p(-hx, -hy, hz)
        e, f = p(-hx, hy, -hz), p(hx, hy, -hz)
        h, i = p(hx, hy, hz), p(-hx, hy, hz)
        self.quad(x, z, name, a, d, c, b, bottom)
        self.quad(x, z, name, e, f, h, i, t)
        self.quad(x, z, name, a, b, f, e, color)
        self.quad(x, z, name, c, d, i, h, color)
        self.quad(x, z, name, b, c, h, f, color)
        self.quad(x, z, name, d, a, e, i, color)

    def cylinder(self, x: float, z: float, name: str, cx, cy, cz, radius, height, color, sides=8):
        g = self.group(x, z, name)
        base = len(g["pos"])
        for k in range(sides):
            ang = k / sides * math.tau
            g["pos"].append((cx + math.cos(ang) * radius, cy, cz + math.sin(ang) * radius))
            g["col"].append(color)
        for k in range(sides):
            ang = k / sides * math.tau
            g["pos"].append((cx + math.cos(ang) * radius, cy + height, cz + math.sin(ang) * radius))
            g["col"].append(color)
        for k in range(sides):
            k2 = (k + 1) % sides
            g["idx"] += [base + k, base + k2, base + sides + k2,
                         base + k, base + sides + k2, base + sides + k]
        # Deckel
        top = len(g["pos"])
        g["pos"].append((cx, cy + height, cz))
        g["col"].append(color)
        for k in range(sides):
            k2 = (k + 1) % sides
            g["idx"] += [base + sides + k, base + sides + k2, top]

    def prism(self, x: float, z: float, name: str, ring_world, z0, z1, color, cap=True):
        g = self.group(x, z, name)
        n = len(ring_world)
        base = len(g["pos"])
        for (wx, wz) in ring_world:
            g["pos"].append((wx, z0, wz))
            g["col"].append(color)
        for (wx, wz) in ring_world:
            g["pos"].append((wx, z1, wz))
            g["col"].append(color)
        for k in range(n):
            k2 = (k + 1) % n
            g["idx"] += [base + k, base + k2, base + n + k2,
                         base + k, base + n + k2, base + n + k]
        if cap:
            top = len(g["pos"])
            cx = sum(p[0] for p in ring_world) / n
            cz = sum(p[1] for p in ring_world) / n
            g["pos"].append((cx, z1, cz))
            g["col"].append(color)
            for k in range(n):
                k2 = (k + 1) % n
                g["idx"] += [base + n + k, base + n + k2, top]

    # ---------------------------------------------------------------- Linien
    def line_boxes(self, x: float, z: float, name: str, coords, height, width, color):
        """UTM-Linienzug -> Kaesten; Hoehe aus dem Gelaende."""
        for i in range(len(coords) - 1):
            x1, y1 = coords[i]
            x2, y2 = coords[i + 1]
            length = math.hypot(x2 - x1, y2 - y1)
            if length < 0.4:
                continue
            wx1, wz1 = x1 - C.ORIGIN_X, -(y1 - C.ORIGIN_Y)
            wx2, wz2 = x2 - C.ORIGIN_X, -(y2 - C.ORIGIN_Y)
            mx, mz = (wx1 + wx2) / 2, (wz1 + wz2) / 2
            yaw = math.atan2(wz2 - wz1, wx2 - wx1)
            gy = min(self.ground(x1, y1), self.ground(x2, y2)) - 0.15
            self.box(x, z, name, mx, gy, mz, length * 1.02, height, width, yaw, color)


def main() -> None:
    t0 = time.time()
    raw = C.raw_dir()
    dlm = raw / "dlm"
    out = C.OUT

    # ------------------------------------------------- Gelaendehoehen (Sampler)
    spec = json.loads((out / "terrain.json").read_text())
    terr = np.frombuffer(gzip.decompress((out / "terrain.bin.gz").read_bytes()), dtype="<i2")
    terr = terr.reshape(spec["ny"], spec["nx"]).astype(np.float32) / 100.0 + spec["originZ"]

    def ground(easting: float, northing: float) -> float:
        col = (easting - C.AREA[0]) / spec["res"]
        row = (C.AREA[3] - northing) / spec["res"]
        i = min(spec["nx"] - 2, max(0, int(col)))
        j = min(spec["ny"] - 2, max(0, int(row)))
        fx, fz = col - i, row - j
        h = (terr[j, i] * (1 - fx) + terr[j, i + 1] * fx) * (1 - fz) + \
            (terr[j + 1, i] * (1 - fx) + terr[j + 1, i + 1] * fx) * fz
        return float(h)

    def W(x, y):
        return (x - C.ORIGIN_X, -(y - C.ORIGIN_Y))

    props = Props(ground)

    def features(name):
        fs = []
        for tile in C.TILES:
            p = dlm / f"{name}_{tile}.geojson"
            if p.exists():
                fs += json.loads(p.read_text())["features"]
        return fs

    counts = {}

    def tally(name, n=1):
        counts[name] = counts.get(name, 0) + n

    # --------------------------------------------------------------- Mauern
    for f in features("walls"):
        p = f["properties"]
        if p.get("kind") != "wall" or f["geometry"]["type"] != "LineString":
            continue
        coords = f["geometry"]["coordinates"]
        props.line_boxes(coords[0][0], coords[0][1], "wall", coords,
                         float(p.get("h") or 1.4), 0.45, COL["wall"])
        tally("wall")

    # --------------------------------------------------------------- Hecken
    for f in features("lowveg"):
        p = f["properties"]
        coords = f["geometry"]["coordinates"]
        color = COL["hedge"] if p.get("kind") == "hedge" else COL["treerow"]
        props.line_boxes(coords[0][0], coords[0][1], "hedge", coords,
                         float(p.get("h") or 1.4), float(p.get("w") or 1.6), color)
        tally("hedge")

    # --------------------------------------------------------------- Bruecken
    for f in features("bridge"):
        p = f["properties"]
        ring_utm = [(x, y) for x, y in f["geometry"]["coordinates"][0]]
        deck = p.get("deck") or []
        z1 = float(np.median(deck)) if deck else ground(*ring_utm[0]) + 4.0
        thick = 1.2 if p.get("kind") == "road" else 0.8
        ring = [W(x, y) for x, y in ring_utm]
        color = COL["bridge"] if p.get("kind") != "rail" else COL["bridge_rail"]
        props.prism(ring_utm[0][0], ring_utm[0][1], "bridge", ring, z1 - thick, z1, color)
        tally("bridge")

    # --------------------------------------------------------------- Denkmaeler
    for f in features("monuments"):
        p = f["properties"]
        kind = p.get("kind")
        if f["geometry"]["type"] == "Point":
            ex, ny = f["geometry"]["coordinates"]
            g = ground(ex, ny)
            if kind == "fountain" or p.get("style") == "basin":
                props.cylinder(ex, ny, "monument", *W(ex, ny), g, 2.2, 0.55, COL["stone"], sides=12)
                props.cylinder(ex, ny, "monument", W(ex, ny)[0], g + 0.35, W(ex, ny)[1],
                               1.85, 0.12, COL["basin"], sides=12)
            elif kind in ("column", "memorial", "monument", "sculpture"):
                props.box(ex, ny, "monument", W(ex, ny)[0], g, W(ex, ny)[1], 1.9, 0.45, 1.9, 0.0, COL["stone"])
                props.cylinder(ex, ny, "monument", W(ex, ny)[0], g + 0.45, W(ex, ny)[1],
                               0.55, 3.4, (152, 148, 138), sides=8)
            else:
                props.box(ex, ny, "monument", W(ex, ny)[0], g, W(ex, ny)[1], 1.2, 0.6, 1.2, 0.0, COL["stone"])
            tally("monument")
        else:
            ring_utm = [(x, y) for x, y in f["geometry"]["coordinates"][0]]
            g = ground(*ring_utm[0])
            props.prism(ring_utm[0][0], ring_utm[0][1], "monument",
                        [W(x, y) for x, y in ring_utm], g, g + 0.6, COL["stone"])
            tally("monument")

    # --------------------------------------------------------------- Masten
    for f in features("structures"):
        p = f["properties"]
        kind = p.get("kind")
        if f["geometry"]["type"] == "Point":
            ex, ny = f["geometry"]["coordinates"]
            wx, wz = W(ex, ny)
            z = float(p.get("z") or ground(ex, ny))
            z = max(z, ground(ex, ny) - 0.5)
            h = float(p.get("h") or 8.0)
            r = float(p.get("r") or 0.4)
            if kind in ("chimney", "silo"):
                props.cylinder(ex, ny, "mast", wx, z, wz, max(0.7, min(r, 3.0)), h, (146, 138, 132), sides=10)
            elif kind in ("mast", "antenna", "tower"):
                props.cylinder(ex, ny, "mast", wx, z, wz, max(0.25, min(r, 1.2)), h, COL["mast"], sides=6)
                props.cylinder(ex, ny, "mast", wx, z + h * 0.6, wz, max(0.35, min(r, 1.8)), 0.7,
                               (146, 148, 150), sides=6)
            else:
                props.cylinder(ex, ny, "mast", wx, z, wz, max(0.3, min(r, 1.0)), h, COL["mast"], sides=6)
            tally("mast")
        else:
            ring_utm = [(x, y) for x, y in f["geometry"]["coordinates"][0]]
            z = float(p.get("z") or ground(*ring_utm[0]))
            props.prism(ring_utm[0][0], ring_utm[0][1], "mast",
                        [W(x, y) for x, y in ring_utm], z, z + float(p.get("h") or 3.0), COL["mast"])
            tally("mast")

    # --------------------------------------------------------------- Bahnsteige
    for f in features("platform"):
        if f["geometry"]["type"] == "Polygon":
            for ring_utm in f["geometry"]["coordinates"][:1]:
                if len(ring_utm) < 3:
                    continue
                g = ground(*ring_utm[0])
                props.prism(ring_utm[0][0], ring_utm[0][1], "platform",
                            [W(x, y) for x, y in ring_utm], g, g + 0.55, COL["platform"], cap=False)
                tally("platform")

    # --------------------------------------------------------------- Gleiskoerper
    for f in features("railarea"):
        ring_utm = [(x, y) for x, y in f["geometry"]["coordinates"][0]]
        g = ground(*ring_utm[0])
        props.prism(ring_utm[0][0], ring_utm[0][1], "ballast",
                    [W(x, y) for x, y in ring_utm], g - 0.1, g + 0.25, COL["ballast"], cap=False)
        tally("ballast")

    # --------------------------------------------------------------- Nebengebaeude
    for f in features("smallbuild"):
        p = f["properties"]
        ring_utm = [(x, y) for x, y in f["geometry"]["coordinates"][0]]
        if len(ring_utm) < 3:
            continue
        z = float(p.get("z") or ground(*ring_utm[0]))
        h = float(p.get("h") or 2.4)
        ring = [W(x, y) for x, y in ring_utm]
        props.prism(ring_utm[0][0], ring_utm[0][1], "shed", ring, z, z + h * 0.9, COL["shed"], cap=False)
        props.prism(ring_utm[0][0], ring_utm[0][1], "shed", ring, z + h * 0.9, z + h, COL["shed_roof"])
        tally("shed")

    # --------------------------------------------------------------- Treppen
    for f in features("stairs"):
        p = f["properties"]
        coords = f["geometry"]["coordinates"]
        if len(coords) < 2:
            continue
        steps = max(1, min(14, int(p.get("n") or 4)))
        w = float(p.get("w") or 2.5)
        z0, z1 = (p.get("z") or [ground(*coords[0]), ground(*coords[0]) + 1.0])[:2]
        for k in range(steps):
            t = (k + 0.5) / steps
            ex = coords[0][0] + (coords[-1][0] - coords[0][0]) * t
            ny = coords[0][1] + (coords[-1][1] - coords[0][1]) * t
            height = z0 + (z1 - z0) * (k + 1) / steps
            yaw = math.atan2(-(coords[-1][1] - coords[0][1]), coords[-1][0] - coords[0][0])
            props.box(ex, ny, "stairs", W(ex, ny)[0], height - 0.18, W(ex, ny)[1],
                      1.1, 0.18, float(w), yaw, COL["stairs"])
        tally("stairs")

    # --------------------------------------------------------------- Stadtmoebel
    STYLE = {
        "bench": ("box", 1.9, 0.45, 0.55, "wood"),
        "picnic": ("box", 1.9, 0.75, 1.6, "wood"),
        "table": ("box", 1.5, 0.75, 0.9, "wood"),
        "bin": ("cyl", 0.35, 0.9, 0, "metal"),
        "bollard": ("cyl", 0.16, 0.9, 0, "dark"),
        "hydrant": ("cyl", 0.2, 0.9, 0, "red"),
        "signal": ("cyl", 0.24, 3.6, 0, "dark"),
        "sign": ("cyl", 0.12, 2.6, 0, "metal"),
        "rack": ("box", 1.5, 0.8, 0.5, "metal"),
        "bike": ("box", 1.5, 0.8, 0.5, "metal"),
        "gate": ("box", 1.3, 1.1, 0.3, "dark"),
        "post": ("cyl", 0.18, 1.0, 0, "dark"),
        "stile": ("box", 0.3, 1.1, 0.3, "wood"),
        "fence": ("box", 1.7, 1.0, 0.25, "metal"),
    }
    for f in features("furniture"):
        if f["geometry"]["type"] != "Point":
            continue
        p = f["properties"]
        style = STYLE.get(p.get("k"))
        if not style:
            continue
        ex, ny = f["geometry"]["coordinates"]
        g = ground(ex, ny)
        wx, wz = W(ex, ny)
        shape, a, b, c, colname = style
        color = COL[colname]
        if shape == "cyl":
            props.cylinder(ex, ny, "furniture", wx, g, wz, a, b, color, sides=6)
        else:
            props.box(ex, ny, "furniture", wx, g, wz, a, b, c, float(p.get("a") or 0) * math.pi / 180, color)
        tally("furniture")

    # --------------------------------------------------------------- Schreiben
    index: dict[str, dict] = {}
    buf = C.Buffer()
    by_name: dict[str, list] = {}
    for cid in sorted(props.chunks):
        for name, g in props.chunks[cid]["groups"].items():
            by_name.setdefault(name, []).append(g)
    for name in sorted(by_name):
        write_group(name, by_name[name], index, buf)

    C.write_gz(out / "props.bin.gz", buf.getvalue())
    C.write_json(out / "props.json", {"index": index, "counts": counts})
    C.log(f"Requisiten: {counts} | {buf.length/1e6:.2f} MB roh | {time.time()-t0:.1f}s")


def write_group(name, groups, index, buf):
    """Eine Gruppe als Block: u32 nVerts, u32 nTris, f32 pos[nv*3],
    u8 col[nv*4], u32 idx[nt*3]."""
    pos, col, idx = [], [], []
    remap = {}
    for g in groups:
        for k, v in enumerate(g["idx"]):
            if v not in remap:
                remap[v] = len(pos)
                pos.append(g["pos"][v])
                col.append(g["col"][v])
            idx.append(remap[v])
    if not idx:
        return
    part = C.Buffer()
    part.u32(len(pos), len(idx) // 3)
    for (px, py, pz) in pos:
        part.f32(px, py, pz)
    for (r, gg, b) in col:
        part.u8(r, gg, b, 255)
    part.array("I", idx)
    payload = part.getvalue()
    index[name] = {"off": buf.length, "len": len(payload), "nv": len(pos), "nt": len(idx) // 3}
    buf.raw(payload)


if __name__ == "__main__":
    main()
