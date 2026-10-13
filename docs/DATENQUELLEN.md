# Datenquellen und Rechte

Alle Geometrie, Höhen und Farben dieses Modells stammen aus amtlichen bzw.
offen lizenzierten Geodaten. Nichts ist erfunden oder abgeschätzt – was nicht
in den Quellen steht, fehlt im Modell (siehe „Grenzen“ unten).

## Gebiet

Ausschnitt der Leipziger Innenstadt, exakt **4 × 4 km** im amtlichen
Koordinatensystem **ETRS89 / UTM Zone 33N (EPSG:25833)**:

| | |
|---|---|
| West–Ost | 316 000 – 320 000 |
| Süd–Nord | 5 688 000 – 5 692 000 |

Enthalten sind die Innenstadt innerhalb des Rings, der Hauptbahnhof, die
nördliche Vorstadt, die Südvorstadt, das Graphische Viertel, die
Nordvorstadt, der Johannapark/Clara-Zetkin-Park am Westrand und der
Wilhelm-Leuschner-Platz im Süden.

## Quellen

| Inhalt | Produkt | Herkunft | Lizenz |
|---|---|---|---|
| Gebäude (LoD2): Grundriss, Dachform, Wand- und Dachflächen, Traufhöhe, Nutzung | LoD2 Sachsen, CityGML | GeoSN – Landesamt für Geobasisinformation Sachsen | dl-de/by-2-0 |
| Geländehöhen (1 m Raster) | DGM1 | GeoSN | dl-de/by-2-0 |
| Landbedeckung, Straßen- und Wegeflächen, Gewässer, Bahnflächen | Basis-DLM (AdV-Shape) | GeoSN | dl-de/by-2-0 |
| Dachfarben | Auswertung des Orthophotos (DOP) | GeoSN | dl-de/by-2-0 |
| Bäume: Standort, Höhe, Kronendurchmesser, Gattung | Baumkataster | Stadt Leipzig, Amt für Stadtgrün und Gewässer | dl-de/by-2-0 |
| Kronenpunkte im Baumbestand (DOM1) | DOM1 | GeoSN | dl-de/by-2-0 |
| Straßenbeläge, Markierungen, Bordsteine, Parkflächen | OpenStreetMap, Mapillary-Auswertung | OSM-Mitwirkende, Mapillary | ODbL / CC BY-SA 4.0 |
| Stadtmöbel, Mauern, Hecken, Denkmäler, Brücken | OpenStreetMap, Basis-DLM | OSM-Mitwirkende, GeoSN | ODbL / dl-de/by-2-0 |
| Straßenbahnlinien und Gleise | GTFS (DELFI/gtfs.de), OSM | DELFI e. V., OSM-Mitwirkende | CC BY 4.0 / ODbL |

Attribution im Modell (Fußzeile und Ladebildschirm):
**Daten: © GeoSN (dl-de/by-2-0) · © OpenStreetMap-Mitwirkende (ODbL) · Stadt
Leipzig, Amt für Stadtgrün und Gewässer · Mapillary (CC BY-SA 4.0)**

## Bezug der Rohdaten

```bash
python3 pipeline/fetch_raw.py        # legt data/raw/leipzig an (rund 91 MB, nicht im Git)
npm run bake                         # erzeugt public/data/*
```

`fetch_raw.py` holt die aufbereiteten Kacheln des offenen Projekts
[`mdugue/bridge`](https://github.com/mdugue/bridge), das die oben genannten
GeoSN-Produkte für dieses Gebiet bereits aufbereitet und unter dl-de/by-2-0
weiterverwendet (nachgewiesen in `data/leipzig/provenance.json` des Projekts).

Wer eigene Bezugswege nutzen will (GeoSN-Portal, Open-Data-Portal der Stadt
Leipzig), legt die Dateien einfach im gleichen Aufbau unter `data/raw/leipzig/`
ab:

```
data/raw/leipzig/
  cityjson/lod2_<kachel>.city.json     LoD2-Gebäude je 2-km-Kachel
  dgm/dgm1_<kachel>_tiff/dgm1_<kachel>.tif   Geländemodell 1 m
  dlm/landcover_<kachel>.png           Landbedeckungsklassen (0,49 m/Rasterzelle)
  dlm/surface_<kachel>.png             Belag/Bearing, RGBA
  dlm/markings_<kachel>.json + .png    Markierungen
  dlm/edges_<kachel>.png               Bordsteinkanten
  dlm/trees_<kachel>.geojson           Baumkataster
  dlm/canopy_<kachel>.geojson          Kronenpunkte aus DOM1
  dlm/{walls,lowveg,bridge,...}.geojson   Requisiten
  dlm/landmarks_<kachel>.json          Wahrzeichen (Wikidata)
  dop/roofcolor_<kachel>.json          Dachfarben aus dem Orthophoto
```

Kacheln: `33316_5688_2_sn`, `33316_5690_2_sn`, `33318_5688_2_sn`,
`33318_5690_2_sn` (Bezeichnung = Easting/Northing in Kilometern).

Ein anderer Ausschnitt funktioniert genauso: die Kachelnamen in
`pipeline/common.py` (`TILES`) und die Gebietsgrenzen (`AREA`, `ORIGIN_*`)
anpassen – die Bake-Schritte skalieren damit automatisch.

## Grenzen des Modells

* **Vier Quadratkilometer.** Der Ausschnitt ist der Innenstadtkern; das
  übrige Stadtgebiet (etwa Grünau, Paunsdorf, der Seehausener Norden) fehlt.
* **Kein Luftbild als Textur.** Die Bodenfarben sind aus Landbedeckung,
  Straßenbelägen, Markierungen, Vegetationsindex (NDVI) und
  Himmelsichtbarkeit (SVF) zusammengesetzt, nicht aus dem Orthophoto
  (dessen Lizenz keine Weiterverbreitung erlaubt). Dachfarben dagegen sind
  echte Messwerte aus dem DOP.
* **Fassaden ohne Foto.** Fenster, Sockel und Ladenzeilen werden aus den
  LoD2-Flächen und OpenStreetMap-Angaben (Ladenlokal, Denkmalschutz)
  abgeleitet; die Wandfarbe kommt aus OSM-Farbangaben oder einer
  typologischen Palette (Putz, Klinker, Sandstein des Leipziger Bestands).
* **Baumkronen als Punkte.** Die Krone ist ein beleuchteter Punkt mit
  Silhouettentextur, kein Einzelbaum-Mesh. Für die Fernwirkung einer
  Baumreihe reicht das, für eine Detailansicht ist es grob.
* **Stand.** Bauwerke nach LoD2-Abgabe 2025 (Erfassungsdatum der Quelle),
  Bäume und Stadtmöbel nach den Open-Data-Ständen im Rohdatensatz
  (`data/raw/leipzig/provenance.json`).
