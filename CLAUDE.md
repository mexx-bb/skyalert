# SkyAlert — CLAUDE.md

> **Projektdokumentation für KI-Assistenten und Entwickler**  
> Progressive Web App für Echtzeit-Flugstatus, globale Live-Radar und Krisennachrichten.

---

## Projektsteckbrief

| Eigenschaft         | Wert                                          |
|---------------------|-----------------------------------------------|
| **Name**            | SkyAlert                                      |
| **Typ**             | Progressive Web App (PWA)                     |
| **Sprache**         | HTML5 / Vanilla CSS / Vanilla JavaScript (ES6+)|
| **Hosting**         | GitHub Pages                                  |
| **Repository**      | https://github.com/mexx-bb/skyalert           |
| **Live-URL**        | https://mexx-bb.github.io/skyalert/           |
| **Lokal testen**    | `python3 -m http.server 8080` im Projektordner|
| **Lokaler Pfad**    | `/Users/rrustemmaksutaj/.gemini/antigravity/scratch/skyalert/` |

---

## Dateistruktur

```
skyalert/
├── index.html          # Komplette App-Shell (alle Tabs als <section class="page">)
├── style.css           # Gesamtes Styling (Dark Mode, CSS Custom Properties, Animationen)
├── app.js              # App-Logik — State, Rendering, UI-Handler, Karte
├── api.js              # AviationStack API Client — Caching, Quota, Transform
├── airports_db.js      # 8000+ Flughäfen-Datenbank für Autocomplete (AIRPORTS_DB[])
├── sw.js               # Service Worker — Offline-First Caching (Cache-Name: skyalert-v5)
├── manifest.json       # PWA Manifest (icons, theme, start_url)
├── build_airports.py   # Hilfsskript zum Generieren der airports_db.js
└── icons/
    ├── icon.svg
    ├── icon-192.png
    └── icon-512.png
```

---

## Architektur

### Kein Framework — reines Vanilla JS

Die App nutzt **kein Frontend-Framework**. Alles ist plain HTML/CSS/JS. State wird in globalen Variablen gehalten (kein Redux, kein Vuex).

### Navigationssystem

Tabs am unteren Bildschirmrand steuern die Sichtbarkeit der `<section class="page">` Elemente:

```js
// Tab-Wechsel in app.js
function switchTab(pageId) { ... }
```

**Wichtig:** Seiten sind mit `display: none` ausgeblendet (NICHT `opacity: 0`), da Leaflet.js eine sichtbare DOM-Größe für die Initialisierung braucht. Beim Wechsel auf den Karten-Tab wird `invalidateSize()` mehrfach verzögert aufgerufen.

### State-Variablen (app.js)

```js
let currentFlights = [];       // Aktuell geladene/gesuchte Flüge (auch Watchlist-Basis!)
let watchlistFlights = [];     // Gemerkete Flüge (gespeichert in localStorage)
let airlineStats = [];         // Berechnet aus currentFlights
let alerts = [];               // Benachrichtigungen (gespeichert in localStorage)
let newsArticles = [];         // Nachrichtenartikel
let dsgvoConsent = null;       // 'full' | 'minimal' | null
```

### localStorage Keys (Präfix: `skyalert_`)

| Key                          | Inhalt                                  |
|------------------------------|-----------------------------------------|
| `skyalert_dsgvo`             | Datenschutz-Einwilligung ('full'/'minimal') |
| `skyalert_watchlist`         | Array transformierter Flugobjekte       |
| `skyalert_alerts`            | Array von Alert-Objekten                |
| `skyalert_recent`            | Letzte Suchanfragen (max. 10)           |
| `skyalert_auto_refresh`      | 'true' / 'false'                        |
| `skyalert_custom_api_key`    | Vom Nutzer hinterlegter AviationStack Key |
| `skyalert_api_counter`       | API Request Counter (monatlich)         |
| `skyalert_api_counter_month` | Monat des letzten Resets                |
| `skyalert_cache_*`           | API Response Cache (TTL-basiert)        |

---

## Datenquellen & APIs

### 1. AviationStack (Primäre Flugdaten)

- **URL:** `https://api.aviationstack.com/v1/flights`
- **Limit:** 500 Requests/Monat (Free Tier)
- **Default Key:** Hardcoded in `api.js` (Zeile 7) — Nutzer kann eigenen Key hinterlegen
- **Key Management:** Nutzer kann in den Einstellungen (Zahnrad oben rechts) einen eigenen Key eintragen → wird in `skyalert_custom_api_key` gespeichert
- **Fallback:** Bei Quota-Überschreitung zeigt die App "Your monthly usage limit has been reached"

#### Caching-TTLs (api.js)

```js
const CACHE_TTL = {
  flights: 3 * 60 * 1000,   // 3 Minuten
  search:  5 * 60 * 1000,   // 5 Minuten
  airlines: 30 * 60 * 1000, // 30 Minuten
  airports: 60 * 60 * 1000  // 1 Stunde
};
```

#### Transformiertes Flugobjekt (nach `transformFlight()`)

```js
{
  number,       // "LH 690" (formatiert)
  numberRaw,    // "LH690" (als Key)
  airline,      // "Lufthansa"
  airlineIata,  // "LH"
  from / to,    // IATA-Codes (z.B. "MUC", "JFK")
  fromCity / toCity,
  depTime / arrTime,      // "14:30" (formatiert)
  depTimeEst / arrTimeEst,
  status,       // 'ontime' | 'delayed' | 'majordelay' | 'cancelled'
  statusText,   // "Planmäßig" | "Verspätet +45min" | "Storniert"
  delay,        // Minuten
  gate, terminal, aircraft,
  flightDate, flightStatus,
  hasLive, latitude, longitude, altitude, speed, direction, isGround,
  lastUpdate,   // timestamp
  _raw          // Original AviationStack Objekt
}
```

### 2. ADSB.lol (Live Radar auf der Karte)

- **URL:** `https://api.adsb.lol/v2/lat/{lat}/lon/{lng}/dist/{km}`
- **Limit:** Keine bekannten — völlig kostenlos, CORS-freundlich
- **Datenformat:** `{ ac: [ { flight, lat, lon, track, alt_baro, alt_geom, ... } ] }`
- **Update-Intervall:** 10 Sekunden (nur wenn Karten-Tab aktiv)
- **Max. Marker:** 400 Flugzeuge gleichzeitig

### 3. Google News RSS (Krisennachrichten)

- Via Proxy: `https://api.rss2json.com/v1/api.json?rss_url=...`
- Queries: Aviation-Krisen, Luftraumsperrungen, Streiks
- **Update-Intervall:** Alle 15 Minuten

---

## Karten-System (Leaflet.js)

```js
let leafletMap = null;    // Leaflet Map Instanz (einmal initialisiert)
let flightMarkers = [];   // Marker für AviationStack-Flüge (grün/gelb/rot)
let radarMarkers = [];    // Marker für ADSB.lol Radar-Flüge (blaue Flugzeug-Icons)
```

### Bekannter Bug — Leaflet + CSS Transition

Leaflet berechnet seine Größe beim initialen Rendering. Da Seiten mit `display: none` ausgeblendet werden, erkennt Leaflet beim Tab-Wechsel nicht sofort die richtige Größe.

**Fix:** `invalidateSize(true)` wird bei Tab-Wechsel zu `pageMap` 4× verzögert aufgerufen (50ms, 150ms, 260ms, 400ms).

**WICHTIG:** Seiten niemals mit `opacity: 0 / transform` verbergen (bricht die Karte). Immer `display: none` / `display: flex`.

### Karten-Tile-Provider

```js
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 })
```

---

## Tab-Seiten (index.html)

| Tab-ID         | Funktion                                    |
|----------------|---------------------------------------------|
| `pageSearch`   | Flugsuche (Flugnummer + Datum + Strecke)    |
| `pageMap`      | Weltkarte mit Live-Radar                    |
| `pageWatchlist`| Gemerkete Flüge                             |
| `pageNews`     | Luftfahrt-Krisennachrichten                 |
| `pageAlerts`   | Benachrichtigungen / Alerts                 |

---

## Suchsystem

### Flugnummer-Suche

- Input: `#searchInput` + optionales Datum `#searchDate`
- `performSearch(query, dateStr)` → `AviationAPI.search(query, dateStr)`
- Ergebnisse werden in `currentFlights` gespeichert (wichtig für Watchlist-Button!)

### Strecken-Suche (Von → Nach)

- Unterstützt Städtenamen (z.B. "München"), IATA-Codes (z.B. "MUC") und Ländernamen
- Mapping-Tabelle in `performRouteSearch()` (app.js) für häufige Städte
- Fallback: Suche in `AIRPORTS_DB`

### Autocomplete

- Datenbank: `AIRPORTS_DB` (airports_db.js) mit 8000+ Einträgen
- Format pro Eintrag: `{ i: "MUC", c: "Munich", co: "Germany" }`

---

## PWA / Service Worker

- **Cache-Name:** `skyalert-v5` (bei Code-Updates muss diese Version erhöht werden!)
- **Strategie:**
  - Navigation: Network-first → Cache-Fallback
  - Static Assets: Cache-first → Network-Fallback
  - Fonts: Stale-While-Revalidate
  - API/Extern: Network → Cache-Fallback

**⚠️ Wichtig:** Bei CSS/JS Änderungen muss `CACHE_NAME` in `sw.js` erhöht werden (z.B. `skyalert-v6`), damit Nutzer das Update erhalten.

---

## DSGVO / Datenschutz

- Beim ersten Start erscheint ein Datenschutz-Overlay
- **"Vollständig akzeptieren"** → `skyalert_dsgvo = 'full'`, Suchverlauf wird gespeichert
- **"Nur Notwendiges"** → `skyalert_dsgvo = 'minimal'`, Suchverlauf wird NICHT gespeichert
- 100% clientseitig — keine serverseitige Datenspeicherung

---

## Alert-System

Alerts werden automatisch aus Flugdaten generiert (`generateAlertsFromFlights()`):
- Verspätungen > 30min
- Stornierungen
- Gate-Änderungen (aus Departure-Gate Wechsel)
- Regionale Warnungen für Naher Osten, Iran, Israel

**Filterung (Alerts-Tab):** Input `#alertsFilter` filtert nach Flughafen-Code, Flugnummer oder Ort live.

**"Alle gelesen":** Button `#markAllRead` setzt `a.unread = false` auf allen Alerts. Nach Klick gibt es visuelles Feedback (Text ändert sich zu "✓ Erledigt" für 2 Sek.). Gelesene Alerts werden mit `opacity: 0.65` angezeigt.

---

## Häufige Fehlerquellen & Lösungen

| Problem | Ursache | Lösung |
|---------|---------|--------|
| Karte zeigt graue Flächen | Leaflet-Größe bei `display:none` falsch berechnet | `invalidateSize(true)` mehrfach verzögert aufrufen |
| Radar lädt nicht | OpenSky-API hat CORS-Beschränkungen | Auf ADSB.lol umgestellt (nativ CORS-kompatibel) |
| Watchlist-Button tut nichts | Gesuchte Flüge waren nicht in `currentFlights` | `performSearch()` und `performRouteSearch()` speichern Ergebnisse jetzt in `currentFlights` |
| API Quota erreicht | AviationStack Free Tier = 500/Monat | Neuen eigenen Key in Einstellungen eintragen |
| App-Update nicht sichtbar | Service Worker cached alte Version | `CACHE_NAME` in `sw.js` erhöhen (z.B. v5 → v6) |
| "Alle gelesen" scheint wirkungslos | Fehlende visuelle Rückmeldung | Button zeigt "✓ Erledigt" + gelesene Alerts werden transparent |

---

## Entwicklungs-Workflow

```bash
# Lokal starten
cd /Users/rrustemmaksutaj/.gemini/antigravity/scratch/skyalert
python3 -m http.server 8080
# → http://localhost:8080

# Änderungen deployen
git add .
git commit -m "feat/fix: Beschreibung"
git push origin main
# → GitHub Pages baut automatisch (~1-2 Minuten)
```

### Bei CSS/JS-Änderungen (Service Worker Cache leeren)

1. `CACHE_NAME` in `sw.js` erhöhen: `skyalert-v5` → `skyalert-v6`
2. Committen & pushen
3. Auf Handy: App im App-Switcher schließen → neu öffnen

---

## Erweiterungspotenzial

- **Dual-API-Fallback:** Bei AviationStack-Quota-Limit auf einen zweiten API-Key (anderer Account) automatisch wechseln
- **FlightAware Firehose:** Nur Enterprise (teuer, nicht für Free-Tier)
- **Push-Notifications:** Würde einen eigenen Backend-Server benötigen (derzeit 100% clientseitig)
- **Mehr Flughäfen im Banner:** Crisis-Daten könnten aus dedizierteren Aviation RSS-Feeds kommen
