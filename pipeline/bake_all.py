#!/usr/bin/env python3
"""Fuehrt alle Bake-Schritte in der richtigen Reihenfolge aus.

Voraussetzung: die Rohdaten der Stadt Leipzig liegen unter data/raw/leipzig
(siehe docs/DATENQUELLEN.md) oder sind ueber LEIPZIG_RAW gesetzt.

    python3 pipeline/bake_all.py

Ergebnis: public/data/*  (Modelldaten des Betrachters)
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

STEPS = [
    ("Gelaende", "bake_terrain.py"),
    ("Gebaeude", "bake_buildings.py"),
    ("Bodentextur", "bake_ground.py"),
    ("Baeume", "bake_trees.py"),
    ("Wasser", "bake_water.py"),
    ("Requisiten", "bake_props.py"),
]

here = Path(__file__).resolve().parent

def main() -> None:
    total = time.time()
    for name, script in STEPS:
        print(f"\n=== {name} ({script}) ===", flush=True)
        t0 = time.time()
        result = subprocess.run([sys.executable, str(here / script)], cwd=here)
        if result.returncode != 0:
            sys.exit(f"Schritt {script} fehlgeschlagen")
        print(f"--- {name} in {time.time()-t0:.1f}s fertig", flush=True)
    print(f"\nAlles gebacken in {time.time()-total:.1f}s.")


if __name__ == "__main__":
    main()
