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
| Fassadenfarben | OSM `building:colour`, wo erfasst | Sonst höhen-/typbasierte Material-Annäherung — im Farbmodus umschaltbar und im Kontrollbericht offengelegt |
| Gelände | AWS Terrain Tiles (Terrarium-DEM, aus SRTM/Copernicus abgeleitet) | Leipzig ist flach (~110–130 m ü. NHN); Überhöhung einstellbar |
| Oberflächen (Satellit) | Esri World Imagery (Echtbild-Luftbilder) | Umschaltbar: Stadtkarte / Satellit / Hybrid |
| Straßen, Gewässer (Pleiße, Weiße Elster, Karl-Heine-Kanal …), Parks | OSM (Basis-Layer des Kartenstils) | Täglich aktualisierte Community-Daten |
| Einzelbäume | OSM `natural=tree`, live per Overpass API | Nur einzeln erfasste Bäume (Button im Panel) |
| Wahrzeichen (20) | Handverifizierte WGS84-Koordinaten, Höhen & Baudaten (`js/landmarks.js`) | Gegen OSM-Objekte und Objektartikel abgeglichen |
| Suche | Nominatim (OSM), auf Leipzigs Bounding Box begrenzt | Adressgenau wie OSM |

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

- 3D-Gebäude mit Höhen-Farbskala oder Fassadenmodus, Sonnenstands-Simulation (6–20 Uhr)
- Satellit / Stadtkarte / Hybrid, Gelände-Relief mit Überhöhung, Labels ein/aus
- 20 Wahrzeichen + 9 Stadtgebiete mit Kameraflügen, automatischer Stadtrundflug
- Gebäude-Klick: Höhe, OSM-ID, Koordinate · Adresssuche · Einzelbäume laden
- HUD mit Koordinate, Zoom und Gebäudezähler · mobil nutzbar

## Datenlizenzen

© OpenStreetMap-Mitwirkende (ODbL) · OpenFreeMap/OpenMapTiles · Esri World Imagery ·
AWS Terrain Tiles / Mapzen (SRTM, Copernicus) · Nominatim & Overpass API (OSM).
