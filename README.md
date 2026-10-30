# OpenZoom – IFC-Viewer im Browser

**Live:** https://graphoflife.github.io/openzoom/ · **Demo direkt laden:** https://graphoflife.github.io/openzoom/?demo

OpenZoom ist ein freier IFC-Viewer, der komplett im Browser läuft (keine Installation, kein Upload – die Dateien bleiben lokal). Bedienung, Menüs und Tastenkürzel sind an **BIMcollab Zoom** angelehnt, damit der Umstieg ohne Einarbeitung klappt.

> OpenZoom ist ein unabhängiges Open-Source-Projekt und nicht mit KUBUS / BIMcollab verbunden. BIMcollab ist eine Marke der KUBUS B.V.

## Funktionen

| Bereich | Was geht |
|---|---|
| **Modelle** | IFC 2x3 / IFC4 / IFC4x3 (web-ifc), mehrere Modelle föderiert, Drag & Drop, `.ifczip`, Projektdatei `.ozp` (Modelle + Ansichten + Issues + Prüfungen) |
| **Navigation** | Orbit um den angeklickten Punkt, Flugmodus (W/A/S/D), Standardansichten, **isometrisch**, Perspektive/Orthogonal, Zoom auf Auswahl |
| **Gebäudestruktur** | Baum nach Gebäudestruktur, IFC-Klasse, Typ, Material oder Geschoss; Sichtbarkeits-Checkboxen, Filter |
| **Eigenschaften** | Übersicht, Ort, Material, Klassifikation, Systeme, alle Psets/Qsets inkl. Typ-Eigenschaften; Tab/Shift+Tab blättert, Mehrfachauswahl zeigt ‹verschieden› |
| **Smart Views** | Regel-Editor wie in Zoom (Elementtyp · Eigenschaft · Operator · Wert · Aktion · Farbe), alle 10 Aktionen inkl. *Automatisch färben*, Legende mit Mengenauszug, **Import/Export `.bcsv`** (BIMcollab-Format v5), Standard-Sets (Geschoss, IFC-Typ, Material, Brandschutz, Prüfungen …) |
| **Sichtbarkeit** | Ein-/Ausblenden, Isolieren, Transparent, Einfärben, „Meine Ansicht“, Bauteil-Schalter (Räume, Wände, Decken …), Rückgängig/Wiederholen |
| **Kollisionsprüfung** | Auswahl A × B (IFC-Klassen, Modelle, Smart Views, Auswahl), harte Kollision mit Toleranz oder Mindestabstand, Status-Verwaltung, Fokus-Ansicht (A rot / B grün), CSV-Export, Kollisionen → BCF-Issues |
| **Schnitte** | Schnittebene per Klick auf eine Fläche, X/Y/Z-Ebenen, **Schnittbox** mit Griffen, Aussetzen, gefüllte Schnittflächen, **Grundriss je Geschoss** (Alt+F) |
| **Messen** | Bemaßung wie Zoom (Klick = lichter Abstand senkrecht, Shift+Klick = Punkt-zu-Punkt, Strg+Klick = Abstand zur Schnittebene), Winkel, Fläche, Abstand zwischen Objekten, Fang an Ecken/Kanten/Mitten, ΔX/ΔY/ΔZ |
| **Höhenkoten** | Koten auf Projektnull (±0,00, frei verschiebbar) oder relativ zum Geschoss |
| **Issues / BCF** | Issues mit Snapshot, Viewpoint, Kommentaren; **BCF 2.1 und 3.0** Import/Export (gegen die buildingSMART-XSDs geprüft) |
| **Listen** | Mengenlisten gruppiert nach beliebiger Eigenschaft mit Summen, CSV-Export für Excel |
| **Anmerkungen** | Linie, Pfeil, Ellipse, Wolke, Rechteck, Text – auf Flächen oder zur Kamera ausgerichtet |

## Tastenkürzel (wie BIMcollab Zoom)

| Kürzel | Funktion | Kürzel | Funktion |
|---|---|---|---|
| Strg+O | Öffnen | Strg+M | Zum Projekt hinzufügen |
| Strg+S | Projekt speichern | Strg+R | Ansicht zurücksetzen |
| Alt+F | Grundrisse | Leertaste | Auswahl ein-/ausblenden |
| Strg+T (Shift+T) | Transparent/deckend | Alt+A / Alt+H | Alles ein-/ausblenden |
| Alt+S/W/L/R/C/B/E/T/D/I/O/M | Räume, Wände, Decken, Dächer, Stützen, Träger, Unterdecken, Treppen, Türen, Fenster, Öffnungen, HLS | Pos1 / Ende | Alles zeigen / Zoom auf Auswahl |
| Strg+2/8/4/6/5/0 | Vorne/Hinten/Links/Rechts/Oben/Unten | Strg+1/3/7/9 | Isometrisch (SW/SO/NW/NO) |
| Strg+= | Senkrecht ausrichten | Strg+L | Kamera waagerecht |
| Alt+V / Alt+= / Alt++ / Alt+- / Alt+* | Meine Ansicht zeigen / festlegen / hinzufügen / entfernen / leeren | Strg+Z / Strg+Y | Rückgängig / Wiederholen |
| Strg+Alt+P | Schnittebene | Strg+B | Schnittbox |
| Entf / Strg+Entf | Ebene löschen / alle Schnitte löschen | Strg+P / Alt+P | Schnitte aussetzen / Ebenen ein/aus |
| Strg+Alt+M | Bemaßung | Strg+Alt+H | Höhenkote |
| Strg+Alt+L/A/E/C/R/T | Anmerkung Linie/Pfeil/Ellipse/Wolke/Rechteck/Text | Strg+F | Suchen |
| Tab / Shift+Tab | Nächstes/voriges Property Set | Strg+C / Strg+V | Wert kopieren / in Suche einfügen |
| W/A/S/D, Q/E, Bild↑/↓, `,` `.` | Flugmodus | Pfeiltasten (+Shift) | Verschieben |

Maus: links ziehen = drehen, Shift+links oder Mitte ziehen = verschieben, Rad = zoomen (Alt = schnell), Strg+Rad = Schnittbox/Ebene, Doppelklick Mitte = alles zeigen. F1 zeigt alle Kürzel.

Hinweis: Browser reservieren einige Kürzel (z. B. Strg+T, Strg+1…9 in Chrome). Dafür gibt es Alternativen (Shift+T, Ansichten-Menü) – als installierte/Vollbild-App funktionieren mehr Kürzel.

## Entwicklung

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # statischer Build in dist/
npm run demo       # Demo-IFC-Modelle neu erzeugen (public/demo)
npm run check      # Demo-Modelle mit web-ifc prüfen + Parser-Smoke-Test
```

Aufbau: `src/core` (Laden im Web-Worker, Rendering mit three.js, Element-Zustand als GPU-Textur, Smart Views, Kollisionen, Schnitte, Messen, BCF) und `src/ui` (Menüs, Panels, Dialoge). Ein Push auf `main` baut und veröffentlicht über GitHub Actions auf GitHub Pages.

## Lizenz

MIT – siehe [LICENSE](LICENSE). Verwendete Bibliotheken: [three.js](https://threejs.org) (MIT), [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (MPL-2.0), [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) (MIT), [fflate](https://github.com/101arrowz/fflate) (MIT). Die Demo-Modelle in `public/demo` werden vom Skript `scripts/generate-demo-ifc.mjs` erzeugt und stehen ebenfalls unter MIT.
