#!/usr/bin/env python3
"""Baut ein annotiertes Uebersichtsbild (Plan) zur Kontrolle der Bakes.

docs/plan.png: Bodentextur + Gebaeudegrundrisse + Wahrzeichen + UTM-Gitter.
"""

from __future__ import annotations

import gzip
import json

from PIL import Image, ImageDraw

import common as C

SIZE = 1600
AREA_PX = 4096.0


def main() -> None:
    raw = C.raw_dir()
    out = C.OUT
    img = Image.open(out / "ground.jpg").convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    draw = ImageDraw.Draw(img, "RGBA")

    def px(x: float, z: float) -> tuple[float, float]:
        """Lokale Koordinaten (x nach Osten, z nach Sueden) -> Bildpixel."""
        return ((x + C.SIZE_M / 2) / C.SIZE_M * SIZE, (z + C.SIZE_M / 2) / C.SIZE_M * SIZE)

    # ---- Gebaeudegrundrisse
    meta = json.loads(gzip.decompress((out / "buildings.meta.json.gz").read_bytes()))
    n = meta["count"]
    for i in range(n):
        cx, cz = meta["cx"][i] / 100.0, meta["cz"][i] / 100.0
        a = meta["a"][i]
        r = max(1.5, (a ** 0.5) / C.SIZE_M * SIZE * 0.5)
        x, y = px(cx, cz)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(40, 40, 60, 150))

    # ---- Wahrzeichen
    lm = {}
    for tile in C.TILES:
        p = raw / "dlm" / f"landmarks_{tile}.json"
        if not p.exists():
            continue
        for l in json.loads(p.read_text())["landmarks"]:
            lm.setdefault(l["name"], l)
    for name, l in sorted(lm.items(), key=lambda kv: -kv[1].get("links", 0))[:40]:
        if not (C.AREA[0] <= l["x"] <= C.AREA[2] and C.AREA[1] <= l["y"] <= C.AREA[3]):
            continue
        x, y = px(l["x"] - C.ORIGIN_X, -(l["y"] - C.ORIGIN_Y))
        draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(220, 30, 30, 255))
        draw.text((x + 5, y - 6), name, fill=(120, 0, 0, 255))

    # ---- Gitter
    for i in range(0, 9):
        v = i / 8
        draw.line([(v * SIZE, 0), (v * SIZE, SIZE)], fill=(255, 255, 255, 60))
        draw.line([(0, v * SIZE), (SIZE, v * SIZE)], fill=(255, 255, 255, 60))
        draw.text((v * SIZE + 2, 4), f"{316000 + i * 500}", fill=(255, 255, 255, 220))
        draw.text((4, v * SIZE + 2), f"{5692000 - i * 500}", fill=(255, 255, 255, 220))

    img.save(C.ROOT / "docs" / "plan.png")
    print("docs/plan.png geschrieben (fuer die Doku als JPEG konvertieren)")


if __name__ == "__main__":
    main()
