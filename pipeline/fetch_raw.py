#!/usr/bin/env python3
"""Rohdaten der Stadt Leipzig beschaffen.

Es gibt keinen allgemein offenen Zugang zu den sächsischen Geobasisdaten
(GeoSN verlangt eine Anmeldung). Dieses Skript holt deshalb die fertig
aufbereiteten Kacheln des offenen Projekts `mdugue/bridge`, das die
Originalprodukte von GeoSN unter der Lizenz dl-de/by-2-0 weiterverwendet:

  LoD2 (CityGML -> CityJSON)   Gebäude mit Dachform, Höhe, Nutzung
  DGM1                          Geländemodell, 1 m Raster
  DOP                           Orthophoto-Auswertung (Dachfarben)
  Basis-DLM                     Landbedeckung, Straßen, Gewässer, Bäume ...

Aufruf:
    python3 pipeline/fetch_raw.py [zielverzeichnis]

Vorgabe des Zielverzeichnisses ist data/raw/leipzig (nicht im Git).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = "https://github.com/mdugue/bridge.git"
SPARSE = "data/leipzig"
KEEP = ("cityjson", "dgm", "dlm", "dop", "transit", "provenance.json")


def run(cmd, cwd=None):
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True)


def main() -> None:
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "data" / "raw" / "leipzig"
    if target.exists() and (target / "cityjson").is_dir():
        print(f"Rohdaten liegen bereits in {target} — nichts zu tun.")
        return

    with tempfile.TemporaryDirectory() as tmp:
        clone = Path(tmp) / "bridge"
        run(["git", "clone", "--filter=blob:none", "--sparse", "--depth", "1", REPO, str(clone)])
        run(["git", "sparse-checkout", "set", SPARSE], cwd=clone)
        src = clone / SPARSE
        if not src.is_dir():
            sys.exit("Der Klon enthält die erwarteten Daten nicht.")
        target.mkdir(parents=True, exist_ok=True)
        for name in KEEP:
            s = src / name
            if not s.exists():
                continue
            d = target / name
            if s.is_dir():
                shutil.copytree(s, d, dirs_exist_ok=True)
            else:
                shutil.copy2(s, d)
            print(f"  übernommen: {name}")

    size = sum(f.stat().st_size for f in target.rglob("*") if f.is_file()) / 1e6
    print(f"\nRohdaten in {target} ({size:.0f} MB). Jetzt `npm run bake` ausführen.")


if __name__ == "__main__":
    main()
