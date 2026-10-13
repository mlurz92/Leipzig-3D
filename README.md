# Leipzig 3D — Hochrealistisches Stadtmodell mit Echtdaten

Interaktives 3D-Modell der Stadt Leipzig im Browser. Alle Gebäude, Straßen, Gewässer und
Grünflächen stammen aus **echten, offenen Geodaten** — keine erfundene Szenerie.

## Starten

Kein Build nötig (reines HTML/CSS/JS, MapLibre GL per CDN):

```bash
python3 -m http.server 5173
# → http://localhost:5173
```

## Was ist echt — und was ist Annäherung? (Transparenz)

| Aspekt | Quelle | Genauigkeit |
|---|---|---|
| Gebäude-Standorte & Grundrisse | OpenStreetMap, als Vektor-Kacheln (OpenMapTiles-Schema via OpenFreeMap) | Lagegenau wie in OSM erfasst (typisch < 1–5 m in der Innenstadt) |
| Gebäudehöhen | OSM `height` / `building:levels` → `render_height` der Kacheln | Echt, wo getaggt; sonst Schätzwert des Datensatzes (in der App gekennzeichnet) |
| Fassadenfarben | Prioritäten-Kette in `deriveFacade()`: 1) OSM `building:colour` (normalisiert), 2) OSM `building:material` (Backstein/Sandstein/Putz/Beton/Glas …), 3) Gebäudetyp + Bauzeit (`start_date`: Gründerzeit-Stuck, Plattenbau-Pastell …), 4) Leipziger Typologie nach Geschossen/Höhe | Jede Farbe inkl. Herkunft im Detail-Klick; pro Gebäude deterministische Helligkeitsvariation + einstellbare Verwitterung (0–80 %) |
| Dachfarben | Eigene 3D-Dachschicht für alle Gebäude; im Detail zusätzlich `roof:colour`/`roof:material`/`roof:shape` (Ziegel, Schiefer, Kupferpatina, Flachdach-Bitumen, Gründach) | Echt, wo getaggt; sonst aus Dachform/Höhe abgeleitet (Herkunft im Klick) |
| Gelände | AWS Terrain Tiles (Terrarium-DEM, aus SRTM/Copernicus abgeleitet) | Leipzig ist flach (~110–130 m ü. NHN); Überhöhung einstellbar |
| Oberflächen (Satellit) | Esri World Imagery (Echtbild-Luftbilder) | Umschaltbar: Stadtkarte / Satellit / Hybrid |
| Straßen, Gewässer (Pleiße, Weiße Elster, Karl-Heine-Kanal …), Parks | OSM (Basis-Layer des Kartenstils) | Täglich aktualisierte Community-Daten |
| Einzelbäume | OSM `natural=tree`, live per Overpass API | Nur einzeln erfasste Bäume (Button im Panel) |
| Wahrzeichen (38) | Handverifizierte WGS84-Koordinaten, Höhen & Baudaten (`js/landmarks.js`) | Gegen OSM-Objekte und Objektartikel abgeglichen |
| Suche | Nominatim (OSM), auf Leipzigs Bounding Box begrenzt | Adressgenau wie OSM |
| Gebäudeteile | OSM `building:part` + `min_height` (Simple 3D Buildings) via Overpass | Türme/Anbauten/Hallen mit eigener Höhe & Fassade |
| Fassadenfotos | Wikimedia Commons API (Wahrzeichen-Info) | Echte Fotos mit Autor/Lizenz zur Farb-Kontrolle |
| Amtl. LoD2 Leipzig | Open Data Leipzig, CKAN-API live + CityGML/Shape/DXF-Downloads (dl-de/by-2-0) | 154.000 Gebäude, Download ohne Texturen; LoD3-Texturen nur im Stadt-Viewer |
| Weitere Quellen | Overture Maps (facade_color/material nativ), EUBUCCO (Baujahr/Höhe/Typ), Microsoft Footprints, GHSL/Urban Atlas, GeoSN DOM1/ALKIS, Mapillary, CC0-Texturen | Bewertung & Offline-Pipeline: siehe **QUELLEN.md**, DuckDB-Abfrage: `scripts/overture_leipzig.sql` |
| Amtl. Luftbild | GeoSN Sachsen, WMS DOP-RGB (dl-de/by-2-0) | Amtliches Orthofoto, in Sachsen i. d. R. 20-cm-Bodenauflösung |
| Detail-Gebäude Zentrum | OSM-Rohdaten live via Overpass (`out geom`): Grundriss, `height`/`levels`, `building:colour`, `roof:shape/colour`, Adresse | Rohdaten-genau; Relations-Multipolygone werden im Browser zusammengesetzt |
| Bahn/Tram, ÖPNV, Radwege, POIs, Stadtteilgrenzen, Gewässer-Verläufe | OSM-Rohdaten live via Overpass | Wie in OSM erfasst; Grenzen als Linien + Schwerpunkt-Labels |
| Bäume 3D | OSM `natural=tree` via Overpass, Kronen als 3D-Extrusion | Standort echt; Kronengröße/Höhe typisiert (OSM erfasst sie selten) |
| Wetter & Sonne | Open-Meteo (DWD ICON), Auf-/Untergang, Live-Uhrzeit | Echtzeit |
| Luftqualität | Open-Meteo Air Quality (CAMS): EU-AQI, PM2.5/PM10, O₃, NO₂ | Echtzeit, modellierte Werte |
| Wasserpegel | Pegelonline (WSV), nächste Station zu Leipzig inkl. aktuellem Messwert | Echtzeit, amtlich |

## Kontrolle der Ergebnisse

Der Button **„✓ Ergebnisse kontrollieren“** in der App

1. zählt die tatsächlich gerenderten 3D-Gebäude im Bildausschnitt,
2. fragt **live** die OSM-Rohdaten der Innenstadt über die Overpass API ab (Gebäude, Gewässer, Straßen, Bäume),
3. gleicht Wahrzeichen-Koordinaten und Höhenangaben (z. B. City-Hochhaus 142 m,
   Völkerschlachtdenkmal 91 m, Neues Rathaus 115 m) als Stichprobe ab und
4. weist offen aus, wo Fassaden Annäherungen sind.

## Amtliche Vertiefung (LoD2, Fassaden)

Für ein amtliches CityGML-LoD2-Modell (Dachformen, Wandflächen) stellt das Land Sachsen
kostenlose 3D-Gebäudedaten bereit (GeoSN, „3D-Gebäudemodelle LoD2“,
https://www.geodaten.sachsen.de/), ebenso das Amt für Geoinformation und Bodenordnung der
Stadt Leipzig. Diese Datensätze sind mehrere GB groß und werden deshalb nicht direkt im
Browser gestreamt; sie können das OSM-Modell lokal z. B. in QGIS/Blender (CityJSON/OBJ-Konvertierung)
ersetzen oder ergänzen. Ein fotorealistisches Fassaden-Foto jedes Gebäudes als freier
amtlicher Datensatz existiert nicht — diese App zeigt deshalb Satelliten-Echtbilder als
Oberflächen-Referenz und markiert Schätzungen transparent.

## Funktionen

- 3D-Gebäude mit Höhen-Farbskala oder Fassadenmodus, Sonnenstands-Simulation (6–20 Uhr) oder Live-Sonne
- Stadtkarte / Satellit / **amtliches GeoSN-Orthofoto** / Hybrid mit Deckkraft-Regler, Gelände-Relief, Labels ein/aus
- **„Alle Detaildaten laden"**: Gebäude-Rohdaten, 3D-Bäume, Bahn/Tram, Haltestellen, Radwege, POIs, Grenzen, Gewässer
- **Echtzeit-Panel**: Wetter, Sonnenzeiten, Luftqualität, Wasserpegel + Datenkatalog mit Live-Status je Quelle
- 38 Wahrzeichen + 9 Stadtgebiete mit Kameraflügen, automatischer Stadtrundflug
- Gebäude-Klick (Basis + Detail mit Adresse/Dachform), POI-/Haltestellen-Klick, Adresssuche
- Export: PNG-Screenshot der Szene, Gebäude des Bildausschnitts als GeoJSON
- HUD mit Koordinate, Geländehöhe am Cursor, Zoom und Gebäudezähler · mobil nutzbar

## Datenlizenzen

© OpenStreetMap-Mitwirkende (ODbL) · OpenFreeMap/OpenMapTiles · Esri World Imagery ·
AWS Terrain Tiles / Mapzen (SRTM, Copernicus) · Nominatim & Overpass API (OSM).
