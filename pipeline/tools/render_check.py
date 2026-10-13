#!/usr/bin/env python3
"""Schnelle Sichtkontrolle der gebackenen Daten ohne Browser.

Statt Dreiecke einzeln zu fuellen, werden die Eckpunkte (und Dreiecksmitten)
aller Flaechen projiziert und in Tiefenreihenfolge als kleine Punkte
geschrieben. Das reicht, um Lage, Hoehen, Dachformen und Farben des Modells zu
beurteilen.

Aufruf:  python3 pipeline/tools/render_check.py [ausgabe.png] [ansicht]
Ansichten: sued (Vorgabe), west, mitte, hoch
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "public" / "data"
SUN = np.array([0.45, 0.72, 0.53])
SUN /= np.linalg.norm(SUN)

SS = 2                       # Ueberabtastung


def load():
    spec = json.loads((DATA / "terrain.json").read_text())
    terrain = np.frombuffer(gzip.decompress((DATA / "terrain.bin.gz").read_bytes()), dtype="<i2")
    terrain = terrain.reshape(spec["ny"], spec["nx"]).astype(np.float32) / 100.0 + spec["originZ"]
    index = json.loads((DATA / "buildings.index.json").read_text())
    blob = gzip.decompress((DATA / "buildings.bin.gz").read_bytes())
    treeidx = json.loads((DATA / "trees.index.json").read_text())
    treeblob = gzip.decompress((DATA / "trees.bin.gz").read_bytes())
    water = json.loads((DATA / "water.json").read_text())
    watertex = np.frombuffer(gzip.decompress((DATA / "water.bin.gz").read_bytes()), dtype=np.uint8)
    ground = np.asarray(Image.open(DATA / "ground.jpg").resize((2048, 2048), Image.LANCZOS), dtype=np.float32) / 255.0
    return spec, terrain, index, blob, treeidx, treeblob, water, watertex, ground


class View:
    def __init__(self, eye, target, w, h, fov=55.0):
        self.eye = np.array(eye, dtype=np.float64)
        fwd = np.array(target, dtype=np.float64) - self.eye
        self.fwd = fwd / np.linalg.norm(fwd)
        right = np.cross(self.fwd, np.array([0.0, 1.0, 0.0]))
        self.right = right / np.linalg.norm(right)
        self.up = np.cross(self.right, self.fwd)
        self.w, self.h = w, h
        self.focal = (h / 2) / np.tan(np.radians(fov) / 2)
        self.img = np.zeros((h, w, 3), dtype=np.float32)
        self.img[:, :] = np.array([0.58, 0.68, 0.80], dtype=np.float32)
        self.zbuf = np.full((h, w), np.inf, dtype=np.float64)

    def splat(self, points, colors, sizes=None, clip=6000.0):
        rel = points - self.eye
        cz = rel @ self.fwd
        keep = (cz > 1.5) & (cz < clip)
        if not keep.any():
            return
        rel, cz, colors = rel[keep], cz[keep], colors[keep]
        if sizes is not None:
            sizes = np.asarray(sizes)[keep]
        cx = rel @ self.right
        cy = rel @ self.up
        sx = (self.w / 2 + cx / cz * self.focal).astype(np.int32)
        sy = (self.h / 2 - cy / cz * self.focal).astype(np.int32)
        if sizes is None:
            sizes = np.full(len(cz), 1)
        sizes = np.maximum(1, np.minimum(80, np.round(sizes / cz * self.focal * 0.5).astype(np.int32)))
        order = np.argsort(-cz)                     # weit zuerst, nahe ueberschreiben
        sx, sy, colors, sizes = sx[order], sy[order], colors[order], sizes[order]

        # Punkte als gefuellte Quadrate schreiben (nach Tiefe sortiert)
        for r in np.unique(sizes):
            sel = sizes == r
            cols = sx[sel]
            rows = sy[sel]
            colr = colors[sel]
            if int(r) <= 14:
                offsets = [(dx, dy) for dy in range(-int(r), int(r) + 1) for dx in range(-int(r), int(r) + 1)]
            else:
                offsets = [(dx, dy) for dx in range(-int(r), int(r) + 1)
                           for dy in (-int(r), int(r))] + \
                          [(dx, dy) for dy in range(-int(r) + 1, int(r))
                           for dx in (-int(r), int(r))]
            for dx, dy in offsets:
                cc = cols + dx
                rr = rows + dy
                ok = (cc >= 0) & (cc < self.w) & (rr >= 0) & (rr < self.h)
                self.img[rr[ok], cc[ok]] = colr[ok]

        inb = (sx >= 0) & (sx < self.w) & (sy >= 0) & (sy < self.h)
        self.img[sy[inb], sx[inb]] = colors[inb]

    def shade(self, normals, base):
        lam = np.clip(normals @ SUN, 0, 1)
        return np.clip(base * (0.45 + 0.75 * lam)[:, None], 0, 1)


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "modell-kontrolle.png"
    which = sys.argv[2] if len(sys.argv) > 2 else "sued"
    views = {
        "sued": ((700, 420, 1500), (-700, 120, -700)),
        "markt": ((-250, 190, 350), (-830, 122, -980)),
        "strasse": ((-640, 126, -560), (-900, 122, -1050)),
        "hoch": ((1400, 900, 1400), (-500, 110, -700)),
    }
    eye, target = views[which]

    spec, terrain, index, blob, treeidx, treeblob, water, watertex, ground = load()
    W, H = 1200 * SS, 675 * SS
    view = View(eye, target, W, H)

    def height(x, z):
        col = np.clip(((x + 2000) / spec["res"]).astype(int), 0, spec["nx"] - 1)
        row = np.clip(((z + 2000) / spec["res"]).astype(int), 0, spec["ny"] - 1)
        return terrain[row, col]

    # ---------------------------------------------------------------- Gelaende
    step = 3.0
    gx, gz = np.meshgrid(np.arange(-2000, 2000, step), np.arange(-2000, 2000, step))
    gy = height(gx, gz)
    gcol = ground[((gz + 2000) / 4000 * 2047).astype(int), ((gx + 2000) / 4000 * 2047).astype(int)]
    pts = np.stack([gx.ravel(), gy.ravel(), gz.ravel()], axis=1)
    view.splat(pts, gcol.reshape(-1, 3) * 0.95, sizes=np.full(len(pts), 2.4))

    # ---------------------------------------------------------------- Wasser
    grid = water["grid"]
    for comp in water["components"]:
        xs = np.arange(comp["x0"], comp["x1"], 4.0)
        zs = np.arange(comp["z0"], comp["z1"], 4.0)
        wx, wz = np.meshgrid(xs, zs)
        if wx.size == 0:
            continue
        gi = np.clip(((wx + 2000) / 4000 * (grid - 1)).astype(int), 0, grid - 1)
        gj = np.clip(((wz + 2000) / 4000 * (grid - 1)).astype(int), 0, grid - 1)
        tex = watertex.reshape(grid, grid, 4)[gj, gi]
        mask = tex[:, :, 3] > 120
        if not mask.any():
            continue
        level = (tex[:, :, 0].astype(np.float32) + tex[:, :, 1].astype(np.float32) * 256 - 32768) / 100 + 100
        wp = np.stack([wx[mask], level[mask] + 0.05, wz[mask]], axis=1)
        view.splat(wp, np.tile(np.array([0.16, 0.26, 0.30], dtype=np.float32), (len(wp), 1)), sizes=np.full(len(wp), 3.0))

    # --------------------------------------------------------------- Gebaeude
    for info in index["chunks"]:
        ox, oz = info["ox"], info["oz"]
        buf = np.frombuffer(blob, dtype=np.uint8, count=info["len"], offset=info["off"])
        nv, nt = np.frombuffer(buf[:8].tobytes(), dtype="<u4")
        hdr = 24
        p = np.frombuffer(buf[hdr:hdr + nv * 6].tobytes(), dtype="<i2").reshape(nv, 3).astype(np.float32) / 100.0
        p[:, 0] += ox
        p[:, 1] += 100.0
        p[:, 2] += oz
        col = buf[hdr + nv * 6:hdr + nv * 10].reshape(nv, 4)[:, :3].astype(np.float32) / 255.0
        at = hdr + nv * 12          # Position (6) + Farbe (4) + Gebaeude-ID (2)
        if info["ib"] == 2:
            idx = np.frombuffer(buf[at:at + nt * 6].tobytes(), dtype="<u2").reshape(nt, 3)
        else:
            idx = np.frombuffer(buf[at:at + nt * 12].tobytes(), dtype="<u4").reshape(nt, 3)
        tri = p[idx]
        nrm = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        ln = np.linalg.norm(nrm, axis=1, keepdims=True)
        ln[ln == 0] = 1
        nrm /= ln
        base = col[idx[:, 0]]
        shaded = view.shade(nrm, base)
        mid = tri.mean(axis=1)
        view.splat(tri[:, 0], shaded, sizes=np.full(len(tri), 1.6))
        view.splat(tri[:, 1], shaded)
        view.splat(tri[:, 2], shaded)
        view.splat(mid, shaded, sizes=np.full(len(tri), 2.2))

    # ----------------------------------------------------------------- Baeume
    for info in treeidx["chunks"]:
        buf = np.frombuffer(treeblob, dtype=np.uint8, count=info["len"], offset=info["off"])
        rec = buf.reshape(info["n"], 8)
        d = np.ascontiguousarray(rec[:, 0:4]).view("<i2").reshape(-1, 2).astype(np.float32) / 100.0
        x = d[:, 0] + info["ox"]
        z = d[:, 1] + info["oz"]
        top = rec[:, 4].astype(np.float32) * 0.2
        radius = np.maximum(1.2, rec[:, 5].astype(np.float32) * 0.1)
        gy = height(x, z)
        crown = np.stack([x, gy + top * 0.72, z], axis=1)
        tone = np.array([0.20, 0.32, 0.15], dtype=np.float32) + (rec[:, 7:8].astype(np.float32) / 7) * np.array([0.1, 0.06, 0.02], dtype=np.float32)
        view.splat(crown, tone, sizes=radius * 2.0)

    img = Image.fromarray((np.clip(view.img, 0, 1) * 255).astype(np.uint8))
    img = img.resize((W // SS, H // SS), Image.LANCZOS)
    img.save(out)
    print(f"{out} geschrieben ({img.size[0]}x{img.size[1]})")


if __name__ == "__main__":
    main()
