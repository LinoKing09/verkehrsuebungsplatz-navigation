# 🚗 Übungsplatz Navi

Turn-by-Turn-Navigation im Google-Maps-Stil für zwei Verkehrsübungsplätze:

| Platz | Straßennetz | Besonderheiten |
|---|---|---|
| **Leonberg**: ADAC Verkehrsübungsanlage am Solitude-Ring | ≈ 2,8 km | Kreisverkehr, Einbahnstraßen, Start- und Zielturm der alten Rennstrecke |
| **Heilbronn**: Verkehrsübungsplatz am Wartberg (Langer Zug) | ≈ 2,7 km | Kreisverkehr, Serpentinen im Weinberg, Stoppschild |

Die App erzeugt **zufällige, abwechslungsreiche Übungsrouten** mit der gewünschten Länge in Minuten und führt dich mit GPS,
Sprachansagen und grünem Abbiege-Banner darüber – so wie im echten Fahrerleben. Optimiert für das **Pixel 8 Pro** (Chrome, Hochformat).

## Benutzung

1. Seite im Chrome auf dem Handy öffnen → Menü ⋮ → **„Zum Startbildschirm hinzufügen“** (dann läuft sie als Vollbild-App und auch offline).
2. Übungsplatz wählen.
3. Mit dem Schieberegler die **Routenlänge (3–60 Min.)** einstellen und einen **Schwerpunkt** wählen
   (Ausgewogen · Viel Kreisel · Linksabbiegen · Ganzer Platz). 🎲 würfelt eine neue Route, das Teilen-Symbol erzeugt einen Link
   genau zu dieser Route. Die Chips zeigen, was dich erwartet (z. B. „9× links · 8× rechts · 2× Kreisel · 80 % des Platzes“).
   „Vorschau“ listet alle Schritte.
4. **GPS (vor Ort)** → *Starten*. Die Route beginnt dort, wo du gerade stehst – sonst (Simulation, oder noch nicht vor Ort)
   immer an der **Einfahrt** des Platzes – und endet an der Einfahrt.
   Stehst du noch neben der Straße, führt eine gepunktete Linie zur Route. Zu Hause kannst du mit **Simulation** (1×/2×/4×) probefahren.
5. Im Ziel landet die Fahrt im **Fahrtenbuch** (Startseite) – mit „Nochmal“ fährst du dieselbe Route erneut.

Während der Fahrt:

- Grünes Banner mit Entfernung, Straße und „Dann …“-Vorschau, Abbiegepfeil auf der Fahrbahn
- Deutsche Sprachansagen („In 50 Metern rechts abbiegen“, „Im Kreisverkehr die zweite Ausfahrt nehmen“)
- Geschwindigkeit + Tempolimit (30), wird rot bei Überschreitung
- Verfahren? → „Route wird neu berechnet“ und du wirst auf die Route zurückgeführt
- Karte verschieben/zoomen → „Zentrieren“; Übersichtskarte über den Karten-Button
- Vibration bei Abbiegeansagen und im Ziel
- Bildschirm bleibt an (Wake Lock), Tag-/Nachtdesign automatisch (🌙 oben schaltet um)

Was sich zwischen den Versionen geändert hat, steht im [CHANGELOG](CHANGELOG.md).

> ⚠️ Handy in eine Halterung, Bedienung nur im Stand. Es gelten immer die Schilder vor Ort und die Platzregeln.

## Hosting (GitHub Pages)

GPS funktioniert im Browser nur über **HTTPS**. Am einfachsten über GitHub Pages:
*Settings → Pages → Source: „GitHub Actions“* – der Workflow in `.github/workflows/pages.yml` veröffentlicht die App dann bei jedem Push.
Lokal testen: `npx http-server .` und `http://localhost:8080` öffnen (localhost gilt als sicher).

## Kartendaten

Die Pläne der Plätze stammen aus **OpenStreetMap** (© OpenStreetMap-Mitwirkende, ODbL) und wurden mit
`tools/extract_osm.py` in `data/*.json` umgewandelt: Straßengraph (Einbahnstraßen, Kreisverkehre, Fahrstreifen), Gebäude,
Grünflächen, Weinberge und umliegende Straßen.

```bash
python3 tools/extract_osm.py   # lädt die Daten neu von api.openstreetmap.org
```

Hinweise:
- Die Übungsplätze haben keine echten Straßennamen – die Namen (Blinkerstraße, Kupplungsgasse, Anfahrberg …) sind frei erfunden. 😉
- Die Anlage in Leonberg wurde 2024/25 saniert. Falls sich der Streckenverlauf geändert hat, in OpenStreetMap korrigieren und das
  Skript neu laufen lassen. Ein geschlossener, kleiner Ring ohne Tag wird automatisch als Kreisverkehr erkannt.
- Start und Ziel ist die Einfahrt (`entrance_node` in `tools/extract_osm.py`): Leonberg die Haupteinfahrt mit Schranken
  von der Mahdentalstraße beim ADAC-Gebäude, Heilbronn die Zufahrt „Langer Zug“.
- Korrekturen, die (noch) nicht in OSM stehen, kommen in `overrides` in `tools/extract_osm.py`
  (z. B. Leonberg: Rechts-vor-links-Weg ist Einbahnstraße aus dem Kreisel heraus).

## Aufbau

```
index.html, css/app.css   Oberfläche (Google-Maps-Look, Material-Farben)
js/graph.js               Straßengraph, Dijkstra, Zufallsroute, Manöver-Erkennung
js/render.js              Vektor-Karte auf Canvas, 3D-Neigung per CSS-Perspektive
js/nav.js                 Ansagen, Banner-Symbole, GPS-Map-Matching, Neuberechnung, Simulator
js/app.js                 Zustände (Auswahl → Planung → Navigation → Ziel), GPS, Gesten
sw.js, manifest           Offline-fähige PWA
```

Die Zufallsroute ist ein gewichteter Zufallslauf durch den Straßengraphen: Bevorzugt werden noch nicht gefahrene Abschnitte und
Manöver, die zuletzt seltener vorkamen (links/rechts/geradeaus/Kreisel). Sackgassen werden gar nicht erst angefahren
(sie werden vorab durch wiederholtes Abschneiden von Endknoten erkannt), man muss also nie wenden. Sobald die Restzeit
gerade noch für den kürzesten Rückweg reicht, geht es zum Ziel. Gleiche Routennummer + gleiche Länge = gleiche Route.
