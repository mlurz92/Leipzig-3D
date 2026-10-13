#!/usr/bin/env python3
"""Bake DGM1 (Gelaendemodell) + LoD2-Grundrisse -> public/data/terrain.bin.gz

Ergebnis: komprimiertes Int16-Hoehenraster (Zentimeter ueber ORIGIN_Z) mit 2 m
Aufloesung, 2000 x 2000 Zellen, Zeile 0 = Nordrand, Spalte 0 = Westrand.
Unter Gebaeuden wird das Gelaende auf die LoD2-Gebaeudebasis gezogen, damit
Waende und Boden bündig sitzen und keine Fugen entstehen.
"""

from __future__ import annotations

import json
import time

import numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin

import common as C

RES = 2.0                          # m pro Rasterzelle
NX = int(C.SIZE_M / RES)           # 2000
NY = int(C.SIZE_M / RES)


def stitch_dgm(raw):
    """Vier 2x2-km-Kacheln zu einem 4000x4000-Raster (1 m) zusammensetzen."""
    out = np.full((int(C.SIZE_M), int(C.SIZE_M)), np.nan, dtype=np.float32)
    for tile in C.TILES:
        path = raw / "dgm" / f"dgm1_{tile}_tiff" / f"dgm1_{tile}.tif"
        with rasterio.open(path) as ds:
            a = ds.read(1).astype(np.float32)
            b = ds.bounds
            col0 = int(round((b.left - C.AREA[0]) / 1.0))
            row0 = int(round((C.AREA[3] - b.top) / 1.0))
            out[row0:row0 + a.shape[0], col0:col0 + a.shape[1]] = a
    if np.isnan(out).any():
        C.log(f"  Warnung: {int(np.isnan(out).sum())} DGM-Luecken, gefuellt per Interpolation")
        mask = np.isnan(out)
        out[mask] = np.nanmean(out)
    return out


def building_footprints(raw):
    """Grundrisse + Basis-Hoehen aller LoD2-Gebaeude (inkl. Bestandteile)."""
    polys, heights = [], []
    for tile in C.TILES:
        cj = json.loads((raw / "cityjson" / f"lod2_{tile}.city.json").read_text())
        scale, trans, verts = cj["transform"]["scale"], cj["transform"]["translate"], cj["vertices"]
        co = cj["CityObjects"]

        def xy(i):
            v = verts[i]
            return (v[0] * scale[0] + trans[0], v[1] * scale[1] + trans[1], v[2] * scale[2] + trans[2])

        for oid, obj in co.items():
            if obj.get("type") != "Building":
                continue
            srcs = [obj] + [co[c] for c in obj.get("children", []) if c in co]
            z_all = []
            rings = []
            for src in srcs:
                for g in src.get("geometry", []):
                    if g.get("lod") not in (None, "2", 2):
                        continue
                    bs = g["boundaries"]
                    if g["type"] == "Solid":
                        bs = [s for shell in bs for s in shell]
                    sem = g.get("semantics")
                    for k, b in enumerate(bs):
                        typ = "WallSurface"
                        if sem and k < len(sem.get("values", [])) and sem["values"][k] is not None:
                            typ = sem["surfaces"][sem["values"][k]]["type"]
                        for ring in b:
                            pts = [xy(i) for i in ring]
                            z_all += [p[2] for p in pts]
                            if typ == "GroundSurface":
                                rings.append([(p[0], p[1]) for p in pts])
            if not rings or not z_all:
                continue
            z0 = float(np.percentile(z_all, 0.5))
            polys.append((rings, z0))
            heights.append(z0)
    C.log(f"  Grundrisse: {len(polys)}")
    return polys


def main() -> None:
    t0 = time.time()
    raw = C.raw_dir()
    out = C.OUT
    out.mkdir(parents=True, exist_ok=True)

    dgm = stitch_dgm(raw)
    C.log(f"DGM1: min {dgm.min():.2f} m, max {dgm.max():.2f} m, Mittel {dgm.mean():.2f} m")

    # auf 2 m blockmitteln
    dgm2 = dgm.reshape(NY, int(RES), NX, int(RES)).mean(axis=(1, 3))

    # Gebaeudebasis in das 2-m-Raster brennen
    C.log("LoD2-Grundrisse einpassen ...")
    polys = building_footprints(raw)
    transform = from_origin(C.AREA[0], C.AREA[3], RES, RES)
    shapes = []
    for rings, z0 in polys:
        shapes.append(({"type": "Polygon", "coordinates": rings}, z0))
    base = rasterize(
        shapes,
        out_shape=(NY, NX),
        transform=transform,
        fill=0.0,
        all_touched=False,
        dtype=np.float32,
    )
    mask = base > 0.0
    diff = base[mask] - dgm2[mask]
    C.log(
        f"  Gebaeudeflaechen: {mask.mean()*100:.1f}% | Hoehendifferenz DGM zu LoD2-Basis: "
        f"Median {np.median(diff):+.2f} m, p95 {np.percentile(np.abs(diff), 95):.2f} m"
    )
    terrain = dgm2.copy()
    terrain[mask] = base[mask]

    # Hoehen als Int16 in Zentimetern relativ ORIGIN_Z, Zeile 0 = Norden
    h_cm = np.round((terrain - C.ORIGIN_Z) * 100.0).astype(np.int16)
    C.write_gz(out / "terrain.bin.gz", h_cm.tobytes(order="C"), level=9)
    C.write_json(
        out / "terrain.json",
        {
            "nx": NX,
            "ny": NY,
            "res": RES,
            "originZ": C.ORIGIN_Z,
            "bbox": list(C.AREA),           # x0, y0, x1, y1 (EPSG:25833)
            "rowOrder": "north-to-south",
            "dtype": "int16 LE, Zentimeter ueber originZ",
            "min": float(terrain.min()),
            "max": float(terrain.max()),
        },
    )
    C.log(f"Terrain fertig in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
