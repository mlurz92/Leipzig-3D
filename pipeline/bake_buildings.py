#!/usr/bin/env python3
"""Bake LoD2-Gebaeudemodell (CityJSON) -> public/data/buildings.{bin.gz,index.json,meta.json.gz}

Ergebnis pro Gebietskachel (250 m):
    u32 nVerts, u32 nTris, f32 ox/oy/oz, u8 idxBytes, u8 kindCounts[4], u16 pad
    i16  pos[nVerts*3]     (Zentimeter relativ zur Kachelmitte)
    u8   col[nVerts*4]     (r, g, b, kind/flags)
    u16  bid[nVerts]       (Gebaeudeindex)
    idx  index[nTris*3]    (u16 oder u32, little endian)
"""

from __future__ import annotations

import json
import math
import time
from collections import Counter

import mapbox_earcut
import numpy as np

import common as C

# --------------------------------------------------------------------------
# Farbwelten
# --------------------------------------------------------------------------

# Leipziger Gruenderzeit-/Wohnbestand: Putzfassaden, Klinker, Sandstein
WALL_RESIDENTIAL = [
    "#e9e2d2", "#e6dcc4", "#dfd2b4", "#d9c9a6", "#e8ddc8", "#f0ece0",
    "#d8c8b0", "#e3cfae", "#cdbe9f", "#dcd3bd", "#e2cfc0", "#ddc6ad",
    "#c9cdb4", "#cfc9b6", "#d6cfc0", "#e5d9b8", "#efe6d4", "#e0d5c2",
]
WALL_BRICK = ["#a9563f", "#b46248", "#9c4f3a", "#8e4a38", "#b76e52", "#a35c45"]
WALL_NONRES = ["#c2c0b8", "#b4b6b4", "#cfccc4", "#a9adae", "#bfc0bb", "#c9c3b6", "#9fa5a8"]
WALL_GLASS = "#8aa0ad"
WALL_CHURCH = ["#cfc4ae", "#c2b7a2", "#c9bda6", "#b9ad96", "#a89478"]

ROOF_FLAT = ["#4c4e50", "#55565a", "#45484a", "#5c5b58", "#3f4245", "#6a6862"]
ROOF_PITCHED = ["#8c4a3a", "#7c4034", "#9a5540", "#6e5744", "#5a4a42", "#a2614a", "#4e4340"]
ROOF_SLATE = ["#3c4247", "#464b50", "#333a3f"]

MATERIAL_COLORS = {
    "plaster": "#e3d8c2",
    "brick": "#a9563f",
    "stone": "#cfc8b8",
    "concrete": "#b8b8b4",
    "glass": WALL_GLASS,
    "metal": "#9aa0a6",
    "wood": "#8a6a4a",
}

KIND_WALL, KIND_ROOF, KIND_GROUND, KIND_OTHER = 0, 1, 2, 3
FLAG_SHOP, FLAG_HERITAGE, FLAG_LANDMARK, FLAG_WINDOWLESS = 4, 8, 16, 32


def _surfaces(obj) -> list[tuple[str, list[list[int]]]]:
    """(Semantiktyp, Ringe) je Flaeche eines CityJSON-Objekts."""
    out = []
    for geom in obj.get("geometry", []):
        if geom.get("type") not in ("MultiSurface", "CompositeSurface", "Solid"):
            continue
        if geom.get("lod") not in (None, "2", 2):
            continue
        boundaries = geom["boundaries"]
        if geom["type"] == "Solid":
            boundaries = [s for shell in boundaries for s in shell]
        sem = geom.get("semantics")
        for i, b in enumerate(boundaries):
            typ = "WallSurface"
            if sem:
                vals = sem.get("values", [])
                if i < len(vals) and vals[i] is not None:
                    typ = sem["surfaces"][vals[i]]["type"]
            out.append((typ, b))
    return out


def newell(pts) -> tuple[float, float, float]:
    nx = ny = nz = 0.0
    n = len(pts)
    for i in range(n):
        x1, y1, z1 = pts[i]
        x2, y2, z2 = pts[(i + 1) % n]
        nx += (y1 - y2) * (z1 + z2)
        ny += (z1 - z2) * (x1 + x2)
        nz += (x1 - x2) * (y1 + y2)
    return nx, ny, nz


def main() -> None:
    t_start = time.time()
    raw = C.raw_dir()
    C.log(f"Rohdaten: {raw}")

    buildings: list[dict] = []          # Metadaten
    per_chunk: dict[int, dict] = {}     # Kachel -> Puffer
    landmark_index: dict[str, int] = {}  # Objekt-ID -> Landmark-Index
    landmark_names: list[str] = []
    landmark_list: list[dict] = []        # Name, Lage, Hoehe fuer Suche/Rundflug
    seen_landmarks: set[str] = set()

    # ---------------------------------------------------------------- Landmarks
    for tile in C.TILES:
        lf = raw / "dlm" / f"landmarks_{tile}.json"
        if not lf.exists():
            continue
        for lm in json.loads(lf.read_text())["landmarks"]:
            if lm["id"] in seen_landmarks:
                continue
            seen_landmarks.add(lm["id"])
            idx = len(landmark_names)
            landmark_names.append(lm["name"])
            lx, lz = lm["x"] - C.ORIGIN_X, -(lm["y"] - C.ORIGIN_Y)
            landmark_list.append({
                "name": lm["name"],
                "x": round(lx, 1),
                "z": round(lz, 1),
                "h": lm.get("h"),
                "height": lm.get("height"),
                "links": lm.get("links", 0),
                "id": lm["id"],
            })
            for oid in lm.get("objects", []):
                landmark_index.setdefault(oid, idx)

    # ---------------------------------------------------------------- Rohdaten
    objects: dict[str, dict] = {}     # Objekt-ID -> (arena, obj, tile)
    attr_osm: dict[str, dict] = {}    # Objekt-ID -> osmbuild-Attribute
    roof_rgb: dict[str, list] = {}    # Objekt-ID -> lineare Dachfarbe (DOP)
    for tile in C.TILES:
        cj = json.loads((raw / "cityjson" / f"lod2_{tile}.city.json").read_text())
        scale = cj["transform"]["scale"]
        trans = cj["transform"]["translate"]
        verts = cj["vertices"]
        for oid, obj in cj["CityObjects"].items():
            objects[oid] = {"obj": obj, "tex": (verts, scale, trans), "tile": tile}
        for oid, at in json.loads((raw / "dlm" / f"osmbuild_{tile}.json").read_text())["objects"].items():
            attr_osm[oid] = at
        rc = raw / "dop" / f"roofcolor_{tile}.json"
        if rc.exists():
            for oid, rgb in json.loads(rc.read_text())["roofs"].items():
                roof_rgb[oid] = rgb
    C.log(f"CityObjects: {len(objects)}, OSM-Attribute: {len(attr_osm)}, Dachfarben: {len(roof_rgb)}")

    # ---------------------------------------------------------------- Gebaeude
    n_tris_total = 0
    n_vert_total = 0
    n_skipped = 0
    kinds = Counter()

    for oid, rec in objects.items():
        obj = rec["obj"]
        if obj.get("type") != "Building":
            continue
        # Flaechen aus dem Gebaeude selbst und allen Bestandteilen (BuildingPart)
        sources = [obj]
        for child in obj.get("children", []):
            ch = objects.get(child, {}).get("obj")
            if ch and ch.get("geometry"):
                sources.append(ch)
        surfs = []
        for src in sources:
            surfs += _surfaces(src)
        if not surfs:
            n_skipped += 1
            continue

        verts, scale, trans = rec["tex"]

        def pt(idx):
            v = verts[idx]
            return (
                v[0] * scale[0] + trans[0],
                v[1] * scale[1] + trans[1],
                v[2] * scale[2] + trans[2],
            )

        # ---- Attribute (vom Gebaeude, sonst vom ersten Bestandteil)
        attrs = dict(obj.get("attributes") or {})
        for src in sources[1:]:
            for k, v in (src.get("attributes") or {}).items():
                attrs.setdefault(k, v)

        zs_all = [pt(i)[2] for _, b in surfs for ring in b for i in ring]
        z0 = min(zs_all)
        z_top = max(zs_all)
        xs = [pt(i)[0] for _, b in surfs for ring in b for i in ring]
        ys = [pt(i)[1] for _, b in surfs for ring in b for i in ring]
        cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)

        # Grundflaeche (Grundrissflaeche) fuer Metadaten
        area = 0.0
        for typ, b in surfs:
            if typ == "GroundSurface" and b:
                ring = [pt(i) for i in b[0]]
                area += abs(C.ring_area([(p[0], p[1]) for p in ring]))

        fcode = str(attrs.get("function") or "")
        fnum = int(fcode.split("_")[0]) if fcode.split("_")[0].isdigit() else 0
        roof_code = attrs.get("roofType")
        try:
            roof_code = int(roof_code)
        except (TypeError, ValueError):
            roof_code = 0

        osm = attr_osm.get(oid, {})
        heritage = bool(osm.get("heritage"))
        shop = bool(osm.get("shop"))
        lm_idx = landmark_index.get(oid)

        # ---- Farben
        seed = abs(hash(oid)) & 0xFFFFFF
        wall = None
        if osm.get("colour"):
            wall = C.hex_color(osm["colour"])
        if wall is None and osm.get("material") in MATERIAL_COLORS:
            wall = C.hex_color(MATERIAL_COLORS[osm["material"]])
        if wall is None:
            if 30000 <= fnum < 40000:
                wall = C.hex_color(C.pick(WALL_RESIDENTIAL, seed))
                if C.hash01(seed * 31 + 7) < 0.14:      # Klinkeranteil
                    wall = C.hex_color(C.pick(WALL_BRICK, seed))
            elif fnum >= 50000:
                wall = C.hex_color(C.pick(WALL_NONRES, seed))
            else:
                wall = C.hex_color(C.pick(WALL_RESIDENTIAL, seed))
        if heritage:
            wall = C.hex_color(C.pick(WALL_CHURCH, seed))
            wall = tuple(int(c * 0.97) for c in wall) if wall else wall
        wall = C.jitter(wall or (200, 195, 185), seed, 0.05)

        # Dach: echte Farbe aus dem Orthophoto, sonst plausibles Dach je Dachform
        roof = None
        if oid in roof_rgb:
            lin = roof_rgb[oid]
            rgb = [int(round(255 * C.linear_to_srgb(c))) for c in lin]
            mx = max(rgb)
            if mx < 90:             # sehr dunkle Messwerte etwas anheben
                k = 90.0 / max(mx, 1)
                rgb = [min(255, int(round(c * k))) for c in rgb]
            roof = tuple(rgb)
        if roof is None:
            if roof_code in (1000, 5000, 9999, 0):
                roof = C.hex_color(C.pick(ROOF_FLAT, seed))
            elif roof_code in (3400, 3200, 3300, 3500, 3600, 3700):
                roof = C.hex_color(C.pick(ROOF_SLATE + ROOF_PITCHED, seed))
            else:
                roof = C.hex_color(C.pick(ROOF_PITCHED, seed))
        roof = C.jitter(roof, seed * 17 + 3, 0.07)

        flags = (FLAG_SHOP if shop else 0) | (FLAG_HERITAGE if heritage else 0) | (
            FLAG_LANDMARK if lm_idx is not None else 0
        )

        bidx = len(buildings)
        buildings.append(
            {
                "id": oid,
                "name": (attrs.get("name") if isinstance(attrs.get("name"), str) and not attrs.get("name", "").startswith("DESNAT") else None),
                "fn": fnum,
                "rt": roof_code,
                "h": int(round((attrs.get("measuredHeight") or (z_top - z0)) * 100)),
                "z0": int(round(z0 * 100)),
                "cx": int(round(cx * 100)),
                "cy": int(round(cy * 100)),
                "a": int(min(65535, round(area))),
                "f": flags,
                "lm": lm_idx,
            }
        )

        # ---- Geometrie
        chunk = C.chunk_of(cx - C.ORIGIN_X, -(cy - C.ORIGIN_Y))
        buf = per_chunk.get(chunk)
        if buf is None:
            ox, oz = C.chunk_origin(chunk)
            buf = per_chunk[chunk] = {
                "ox": ox, "oy": 0.0, "oz": oz,
                "verts": {},          # (vertexId, kind) -> lokalindex
                "pos": [], "col": [], "bid": [], "idx": [],
                "n_buildings": 0,
            }
        ox, oz = buf["ox"], buf["oz"]

        def local_index(vertex_id: int, kind: int, color) -> int:
            key = (vertex_id, kind)
            li = buf["verts"].get(key)
            if li is None:
                ex, ny, hh = pt(vertex_id)
                li = len(buf["pos"])
                buf["verts"][key] = li
                buf["pos"].append((ex - C.ORIGIN_X - ox, hh - C.ORIGIN_Z, -(ny - C.ORIGIN_Y) - oz))
                buf["col"].append((color[0], color[1], color[2], kind | flags))
                buf["bid"].append(bidx)
            return li

        for typ, rings in surfs:
            if not rings:
                continue
            kind = KIND_WALL
            if typ == "RoofSurface":
                kind = KIND_ROOF
            elif typ == "GroundSurface":
                kind = KIND_GROUND
            elif typ in ("WallSurface",):
                kind = KIND_WALL
            else:
                kind = KIND_OTHER

            outer = [pt(i) for i in rings[0]]
            if len(outer) < 3:
                continue
            nx, ny, nz = newell(outer)
            if abs(nx) < 1e-9 and abs(ny) < 1e-9 and abs(nz) < 1e-9:
                continue
            # Projektion auf die Flaechenebene (Achse mit groesster Normalkomponente weglassen)
            navg = max(abs(nx), abs(ny), abs(nz))
            if abs(nz) >= navg:
                proj = lambda p: (p[0], p[1])
            elif abs(nx) >= abs(ny):
                proj = lambda p: (p[1], p[2])
            else:
                proj = lambda p: (p[0], p[2])

            flat: list[float] = []
            ends: list[int] = []
            for ring in rings:
                if len(ring) < 3:
                    continue
                for i in ring:
                    p = pt(i)
                    u, v = proj(p)
                    flat += [u, v]
                ends.append(len(flat) // 2)
            if len(ends) == 0 or ends[-1] < 3:
                continue
            tri = mapbox_earcut.triangulate_float64(
                np.asarray(flat, dtype=np.float64).reshape(-1, 2), np.asarray(ends, dtype=np.uint32)
            )

            color = wall if kind != KIND_ROOF else roof
            # Ringpunkt -> Original-VertexId (eartcut-Indizes zeigen auf die Ringpunkte)
            ring_ids = [i for ring in rings if len(ring) >= 3 for i in ring]
            n_valid = len(ring_ids)
            for t in range(0, len(tri) - 2, 3):
                a, b, c = int(tri[t]), int(tri[t + 1]), int(tri[t + 2])
                if max(a, b, c) >= n_valid:
                    continue
                pa, pb, pc = pt(ring_ids[a]), pt(ring_ids[b]), pt(ring_ids[c])
                # Flaechennormale der Dreiecke mit der Flaechennormale abgleichen
                ux, uy, uz = pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]
                vx, vy, vz = pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]
                cx_, cy_, cz_ = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
                if cx_ * nx + cy_ * ny + cz_ * nz < 0:
                    b, c = c, b
                ia = local_index(ring_ids[a], kind, color)
                ib = local_index(ring_ids[b], kind, color)
                ic = local_index(ring_ids[c], kind, color)
                if ia == ib or ib == ic or ia == ic:
                    continue
                buf["idx"] += [ia, ib, ic]
                kinds[kind] += 1
        buf["n_buildings"] += 1

    # ---------------------------------------------------------------- Schreiben
    out = C.OUT
    out.mkdir(parents=True, exist_ok=True)
    blob = C.Buffer()
    index = []
    for chunk in sorted(per_chunk):
        buf = per_chunk[chunk]
        nv = len(buf["pos"])
        nt = len(buf["idx"]) // 3
        if nv == 0 or nt == 0:
            continue
        idx_bytes = 2 if nv <= 65535 else 4
        part = C.Buffer()
        part.u32(nv, nt)
        part.f32(buf["ox"], C.ORIGIN_Z, buf["oz"])
        part.u8(idx_bytes, 0, 0, 0)
        for p in buf["pos"]:
            part.i16(
                max(-32768, min(32767, int(round(p[0] * 100)))),
                max(-32768, min(32767, int(round(p[1] * 100)))),
                max(-32768, min(32767, int(round(p[2] * 100)))),
            )
        for c in buf["col"]:
            part.u8(c[0] & 255, c[1] & 255, c[2] & 255, c[3] & 255)
        part.array("H", buf["bid"])
        if idx_bytes == 2:
            part.array("H", buf["idx"])
        else:
            part.array("I", buf["idx"])
        payload = part.getvalue()
        index.append(
            {
                "i": chunk,
                "off": blob.length,
                "len": len(payload),
                "nv": nv,
                "nt": nt,
                "ox": round(buf["ox"], 2),
                "oz": round(buf["oz"], 2),
                "ib": idx_bytes,
            }
        )
        blob.raw(payload)
        n_tris_total += nt
        n_vert_total += nv

    C.write_gz(out / "buildings.bin.gz", blob.getvalue())
    C.write_json(
        out / "buildings.index.json",
        {
            "origin": [C.ORIGIN_X, C.ORIGIN_Y, C.ORIGIN_Z],
            "chunkM": C.CHUNK_M,
            "chunksPerSide": C.CHUNKS_PER_SIDE,
            "nBuildings": len(buildings),
            "nVertices": n_vert_total,
            "nTriangles": n_tris_total,
            "chunks": index,
        },
    )

    meta = {
        "count": len(buildings),
        "ids": [b["id"] for b in buildings],
        "fn": [b["fn"] for b in buildings],
        "rt": [b["rt"] for b in buildings],
        "h": [b["h"] for b in buildings],
        "z0": [b["z0"] for b in buildings],
        "cx": [b["cx"] for b in buildings],
        "cz": [-int(round((b["cy"] - C.ORIGIN_Y) * 100)) for b in buildings],
        "a": [b["a"] for b in buildings],
        "f": [b["f"] for b in buildings],
        "lm": [(-1 if b["lm"] is None else b["lm"]) for b in buildings],
        "lmNames": landmark_names,
        "landmarks": landmark_list,
        "names": {str(i): b["name"] for i, b in enumerate(buildings) if b["name"]},
    }
    C.write_json_gz(out / "buildings.meta.json.gz", meta)

    C.log(
        f"Gebaeude: {len(buildings)} (uebersprungen: {n_skipped}) | "
        f"Dreiecke: {n_tris_total/1e6:.2f} Mio | Vertices: {n_vert_total/1e6:.2f} Mio | "
        f"Kacheln: {len(index)} | Flaechen: {dict(kinds)} | {time.time()-t_start:.1f}s"
    )


if __name__ == "__main__":
    main()
