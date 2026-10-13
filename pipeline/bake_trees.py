#!/usr/bin/env python3
"""Bake Baeume -> public/data/trees.bin.gz + trees.index.json

Zwei Quellen werden verschmolzen:
  * Baumkataster der Stadt Leipzig (Punkt, Hoehe h, Kronendurchmesser d, Archetyp a)
  * Kronenpunkte aus dem Oberflaechenmodell DOM1 (`canopy_*`, Kronenspitze h)

Pro Punkt (8 Byte):
  i16 x, i16 z   Zentimeter relativ zur Kachelmitte
  u8  top        Hoehe der Krone ueber Grund in 20-cm-Schritten (max 51 m)
  u8  radius     Kronenradius in 10-cm-Schritten (max 25,5 m)
  u8  art        Archetyp 0..5, +16 wenn nur aus dem DOM (Silhouette)
  u8  farbe      Farbgruppe (0..7) aus der Gattung
"""

from __future__ import annotations

import json
import math
import time

import numpy as np

import common as C

DEDUPE_M = 4.0

ARCHETYPES = ["round", "oval", "columnar", "conifer", "weeping", "small"]

# Gattung -> Farbgruppe (0..7): 0 dunkelgruen, 1 mittelgruen, 2 hellgruen,
# 3 gelbgruen, 4 blaugruen, 5 rotbraun, 6 silbergrau, 7 bluete/fruehling
GENUS_GROUP = {
    "Tilia": 1, "Acer": 1, "Acer rubrum": 5, "Quercus": 0, "Quercus rubra": 5,
    "Fraxinus": 2, "Aesculus": 1, "Prunus": 7, "Platanus": 1, "Robinia": 2,
    "Carpinus": 1, "Crataegus": 1, "Gleditsia": 3, "Sophora": 1, "Ulmus": 1,
    "Betula": 2, "Malus": 7, "Liquidambar": 5, "Populus": 3, "Ailanthus": 2,
    "Salix": 3, "Alnus": 1, "Koelreuteria": 3, "Sorbus": 2, "Liriodendron": 1,
    "Catalpa": 1, "Corylus": 1, "Pyrus": 2, "Ginkgo": 3, "Ostrya": 1,
    "Fagus": 0, "Castanea": 1, "Juglans": 1, "Celtis": 1, "Larix": 3,
    "Picea": 4, "Pinus": 4, "Abies": 4, "Pseudotsuga": 4, "Thuja": 4,
    "Chamaecyparis": 4, "Taxus": 4, "Juniperus": 4, "Metasequoia": 3,
    "Gymnocladus": 1, "Magnolia": 7, "Amelanchier": 7, "Cornus": 7,
    "Viburnum": 7, "Syringa": 7, "Rhus": 3, "Laburnum": 7, "Wisteria": 7,
}
CONIFER = {"Picea", "Pinus", "Abies", "Pseudotsuga", "Thuja", "Chamaecyparis", "Taxus", "Juniperus", "Larix"}


def main() -> None:
    t0 = time.time()
    raw = C.raw_dir()
    out = C.OUT
    dlm = raw / "dlm"

    # ------------------------------------------------------------- Terrain
    terrain = None
    tj = out / "terrain.json"
    if tj.exists():
        spec = json.loads(tj.read_text())
        H = np.frombuffer(
            __import__("gzip").decompress((out / "terrain.bin.gz").read_bytes()), dtype="<i2"
        ).reshape(spec["ny"], spec["nx"]).astype(np.float32) / 100.0 + spec["originZ"]
        terrain = H

    def ground(x: float, y: float) -> float:
        if terrain is None:
            return 0.0
        col = int((x - C.AREA[0]) / (C.SIZE_M / terrain.shape[1]))
        row = int((C.AREA[3] - y) / (C.SIZE_M / terrain.shape[0]))
        col = min(max(col, 0), terrain.shape[1] - 1)
        row = min(max(row, 0), terrain.shape[0] - 1)
        return float(terrain[row, col])

    # ------------------------------------------------------------- Quellen
    per_chunk: dict[int, list[tuple]] = {}

    def add(x: float, y: float, top: float, radius: float, art: int, color: int, key: tuple | None):
        lx, lz = x - C.ORIGIN_X, -(y - C.ORIGIN_Y)
        ch = C.chunk_of(lx, lz)
        per_chunk.setdefault(ch, []).append((x, y, top, radius, art, color, key))

    n_kat = n_can = 0
    for tile in C.TILES:
        km = dlm / f"trees_{tile}.geojson"
        if km.exists():
            data = json.loads(km.read_text())
            genera = data["genera"]
            for f in data["features"]:
                x, y = f["geometry"]["coordinates"]
                p = f["properties"]
                h = float(p.get("h") or 10.0)
                d = float(p.get("d") or max(3.0, h * 0.55))
                art = int(p.get("a") or 0)
                gn = p.get("gn")
                genus = genera[gn] if isinstance(gn, int) and 0 <= gn < len(genera) else ""
                grp = GENUS_GROUP.get(genus, 0)
                if genus in CONIFER and art == 0:
                    art = 3
                base = ground(x, y)
                add(x, y, h, max(1.0, d / 2.0), art, grp, (round(x / DEDUPE_M), round(y / DEDUPE_M)))
                n_kat += 1
        cm = dlm / f"canopy_{tile}.geojson"
        if cm.exists():
            for f in json.loads(cm.read_text())["features"]:
                x, y = f["geometry"]["coordinates"]
                # `h` ist bereits die Kronenspitze ueber Grund (3..45 m)
                top = float(f["properties"]["h"])
                if top < 3.0:
                    continue
                add(x, y, top, max(1.2, top * 0.30), 0, 0, None)
                n_can += 1

    # ------------------------------------------------------------- Verschmelzen
    chunks: list[dict] = []
    buf = C.Buffer()
    n_total = 0
    for ch in sorted(per_chunk):
        pts = per_chunk[ch]
        keys = {p[6] for p in pts if p[6] is not None}
        keep = []
        for p in pts:
            if p[6] is None and p[6] is None:
                # DOM-Punkt: nur behalten, wenn kein Katasterbaum in der Naehe
                near = False
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        k = (round(p[0] / DEDUPE_M) + dx, round(p[1] / DEDUPE_M) + dy)
                        if k in keys:
                            near = True
                            break
                    if near:
                        break
                if near:
                    continue
            keep.append(p)
        if not keep:
            continue
        ox, oz = C.chunk_origin(ch)
        start = buf.length
        for x, y, top, radius, art, color, key in keep:
            lx = (x - C.ORIGIN_X) - ox
            lz = -(y - C.ORIGIN_Y) - oz
            kataster = key is not None
            buf.i16(
                max(-32768, min(32767, int(round(lx * 100)))),
                max(-32768, min(32767, int(round(lz * 100)))),
            )
            buf.u8(
                max(1, min(255, int(round(top / 0.2)))),
                max(1, min(255, int(round(radius / 0.1)))),
                (art & 15) | (0 if kataster else 16),
                color & 7,
            )
        chunks.append(
            {"i": ch, "off": start, "n": len(keep), "len": buf.length - start, "ox": round(ox, 1), "oz": round(oz, 1)}
        )
        n_total += len(keep)

    C.write_gz(out / "trees.bin.gz", buf.getvalue())
    C.write_json(out / "trees.index.json", {"chunkM": C.CHUNK_M, "chunks": chunks, "count": n_total})
    C.log(
        f"Baeume: {n_total} (Kataster {n_kat}, DOM-Kronen {n_can}, verschmolzen), "
        f"{len(chunks)} Kacheln, {time.time()-t0:.1f}s"
    )


if __name__ == "__main__":
    main()
