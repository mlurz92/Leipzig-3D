#!/usr/bin/env python3
"""Bake Wasserflaechen -> public/data/water.bin.gz + water.json

Die Landbedeckung liefert Gewaesserlinien; ueber Wasser ist das Laser-Gelaende
im DGM nahezu eben, dort liegt also der Wasserspiegel. Aus den Gelaendehoehen
der Wasserzellen wird deshalb ein geglaettetes Spiegelfeld gebildet (und in die
Umgebung hinein verlaengert, damit die Randpunkte eines Wasserkoerpers ebenfalls
eine sinnvolle Hoehe bekommen).

water.bin.gz : int16-Raster 2048², Zentimeter ueber ORIGIN_Z, 0 = kein Wasser
water.json   : Rastermasse und die zusammenhaengenden Wasserkoerper (Huelle)
"""

from __future__ import annotations

import gzip
import json
import time
from collections import deque

import numpy as np
from PIL import Image

import common as C

GRID = 2048            # 1,95 m je Zelle
SMOOTH_ITERS = 12      # Glaettung des Spiegelfelds
FILL_ITERS = 40        # Verlaengerung in die Umgebung


def box_blur(field: np.ndarray, weight: np.ndarray, passes: int) -> tuple[np.ndarray, np.ndarray]:
    """Normalisierte 3x3-Boxfilterung, nur ueber gueltige Zellen."""
    f, w = field.copy(), weight.copy()
    for _ in range(passes):
        fs = np.zeros_like(f)
        ws = np.zeros_like(w)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                fs += np.roll(np.roll(f, dy, axis=0), dx, axis=1)
                ws += np.roll(np.roll(w, dy, axis=0), dx, axis=1)
        valid = ws > 0
        f = np.where(valid, fs / np.maximum(ws, 1e-6), 0.0)
        w = np.where(valid, 1.0, 0.0)
    return f, w


def main() -> None:
    t0 = time.time()
    raw = C.raw_dir()
    out = C.OUT

    spec = json.loads((out / "terrain.json").read_text())
    ter = np.frombuffer(gzip.decompress((out / "terrain.bin.gz").read_bytes()), dtype="<i2")
    ter = ter.reshape(spec["ny"], spec["nx"]).astype(np.float32) / 100.0 + spec["originZ"]

    # --------------------------------------------------- Wasserlinien -> Raster
    mask = np.zeros((GRID, GRID), dtype=bool)
    for tile in C.TILES:
        parts = tile.split("_")
        x0, y0 = int(parts[0][2:]) * 1000, int(parts[1]) * 1000
        a = np.asarray(Image.open(raw / "dlm" / f"landcover_{tile}.png")) == 8
        a = a.reshape(1024, 4, 1024, 4).any(axis=(1, 3))
        c0 = int(round((x0 - C.AREA[0]) / (C.SIZE_M / GRID)))
        r0 = int(round((C.AREA[3] - (y0 + 2000)) / (C.SIZE_M / GRID)))
        mask[r0:r0 + 1024, c0:c0 + 1024] = a
    C.log(f"Wasserzellen: {int(mask.sum())} ({mask.mean()*100:.2f} %)")

    # Gelaendehoehe an den Wasserzellen (2-m-Terrain auf das Raster abtasten)
    ty = np.clip((np.arange(GRID) * GRID / ter.shape[0]).astype(int), 0, ter.shape[0] - 1)
    tx = np.clip((np.arange(GRID) * GRID / ter.shape[1]).astype(int), 0, ter.shape[1] - 1)
    ter_low = ter[np.ix_(ty, tx)]

    field = np.where(mask, ter_low, 0.0).astype(np.float32)
    weight = mask.astype(np.float32)
    field, weight = box_blur(field, weight, SMOOTH_ITERS)

    # Fluesse liegen im DGM oft tiefer als der Spiegel: gegen die Uferhoehe
    # anheben, damit die Flaeche knapp unter den Uferkanten bleibt.
    bank = box_blur(np.where(mask, ter_low, 0.0), weight, 0)[0]
    field = np.maximum(field, bank - 0.05)

    # in die Umgebung verlaengern (Randpunkte der Wasserkoerper brauchen Werte)
    for _ in range(FILL_ITERS):
        f_sum = np.zeros_like(field)
        w_sum = np.zeros_like(weight)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                f_sum += np.roll(np.roll(field, dy, axis=0), dx, axis=1) * np.roll(np.roll(weight, dy, axis=0), dx, axis=1)
                w_sum += np.roll(np.roll(weight, dy, axis=0), dx, axis=1)
        new = (w_sum > 0) & (weight == 0)
        field = np.where(new, f_sum / np.maximum(w_sum, 1e-6), field)
        weight = np.where(new | (weight > 0), 1.0, 0.0)

    water_cm = np.where(mask, np.round((field - C.ORIGIN_Z) * 100.0), 0).astype(np.int16)

    # Als RGBA8-Raster ablegen (als Textur im Betrachter nutzbar):
    #   R,G = Spiegelhoehe als uint16 (Zentimeter + 32768, kleine Endung)
    #   B   = 0 (frei)
    #   A   = 255 auf Wasser, sonst 0 - der Randbereich ist weich (Tent)
    level = np.clip(np.round((field - C.ORIGIN_Z) * 100.0) + 32768.0, 0, 65535).astype(np.uint16)
    tex = np.zeros((GRID, GRID, 4), dtype=np.uint8)
    tex[:, :, 0] = level & 0xFF
    tex[:, :, 1] = level >> 8
    tex[:, :, 3] = np.where(mask, 255, 0).astype(np.uint8)
    C.write_gz(out / "water.bin.gz", tex.tobytes(order="C"), level=9)

    # --------------------------------------------------- Wasserkoerper (Huelle)
    label = np.zeros((GRID, GRID), dtype=np.int32)
    components = []
    step = C.SIZE_M / GRID
    for r, c in np.transpose(np.nonzero(mask)):
        if label[r, c]:
            continue
        idx = len(components) + 1
        label[r, c] = idx
        q = deque([(r, c)])
        cells = []
        while q:
            y, x = q.popleft()
            cells.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < GRID and 0 <= xx < GRID and mask[yy, xx] and not label[yy, xx]:
                    label[yy, xx] = idx
                    q.append((yy, xx))
        ys = np.array([c2[0] for c2 in cells])
        xs = np.array([c2[1] for c2 in cells])
        components.append(
            {
                "x0": round(float(xs.min()) * step - C.SIZE_M / 2, 1),
                "z0": round(float(ys.min()) * step - C.SIZE_M / 2, 1),
                "x1": round(float(xs.max() + 1) * step - C.SIZE_M / 2, 1),
                "z1": round(float(ys.max() + 1) * step - C.SIZE_M / 2, 1),
                "area": int(len(cells) * step * step),
                "cells": len(cells),
                "level": int(round(float(np.median(water_cm[ys, xs])))),
            }
        )
    components.sort(key=lambda c: -c["area"])
    for c in components[:6]:
        C.log(f"  {c['area']:7d} m²  x {c['x0']+2000:7.1f}..{c['x1']+2000:7.1f}  z {c['z0']+2000:7.1f}..{c['z1']+2000:7.1f}")

    C.write_json(
        out / "water.json",
        {
            "grid": GRID,
            "encoding": "RGBA8: R/G = Spiegelhoehe uint16 (cm+32768), A = Wasserdeckung",
            "originZ": C.ORIGIN_Z,
            "cellM": step,
            "bbox": list(C.AREA),
            "components": components,
        },
    )
    C.log(f"Wasser: {len(components)} Koerper, Wasserstand {water_cm[mask].min()/100+C.ORIGIN_Z:.2f}"
          f"..{water_cm[mask].max()/100+C.ORIGIN_Z:.2f} m | {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
