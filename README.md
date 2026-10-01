# blaue-giraffe-app

> **Testphase.** Ausführliche Anleitung mit Test-Checkliste: `docs/app.md` im (privaten) Hauptrepo.

Handy-Web-App für die **Wochen-Issue** des Kita-Dienstplans (privates Repo `blaue-giraffe`). Sie zeigt die
Woche übersichtlich an und macht dasselbe wie die GitHub-App, nur bequemer: Häkchen setzen, eine
Aushilfe mit Namen eintragen, „Neu berechnen und senden“, „Alles zurücksetzen“, Wochen anlegen.

**Dieses Repo enthält keine Daten** – keine Namen, keine Dienstpläne, keine Kinder. Die Seite lädt alles
erst auf dem Handy über die GitHub-API aus dem privaten Repo, mit einem Zugangsschlüssel, der nur auf dem
Gerät gespeichert ist. Gerechnet und verschickt wird weiterhin vom Workflow `woche.yml` im Hauptrepo.

Adresse: <https://lienertt.github.io/blaue-giraffe-app/>

## Einrichten

1. **Zugangsschlüssel anlegen:** auf github.com unter *Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token*
   - *Repository access:* **Only select repositories** → `blaue-giraffe`
   - *Permissions → Repository permissions:* **Issues: Read and write** (mehr braucht es nicht)
   - *Expiration:* z. B. 1 Jahr – danach einfach einen neuen anlegen und in der App eintragen.
2. Die Adresse oben auf dem Handy öffnen, ⚙ antippen, den Schlüssel einfügen, speichern.
3. **Zum Startbildschirm hinzufügen** (Android/Chrome: Menü → „App installieren“ bzw. „Zum
   Startbildschirm“; iPhone/Safari: Teilen → „Zum Home-Bildschirm“). Dann startet sie wie eine App.

## Bedienen

- **Oben:** Woche wählen; „+ Woche“ legt eine neue Wochen-Issue an. Für die aktuelle oder eine künftige
  Woche geht dabei sofort die Wochenmeldung raus, eine vergangene Woche wird nur ausgewertet.
- **Je Tag:** die Bewertung aus dem letzten Lauf (🟢/🟠/🔴), Kinderzahl, ein Schalter „krank“ je Person
  und für offene Aushilfe-Schichten die Auswahl *gesucht / gefunden / keine*.
  Aufklappbar: die Kinder des Tages (Vornamen, `*` Eingewöhnung, „bis 14:00“ frühe Abholung) und wer
  fehlt (krank/Urlaub) – aus der Antwort der Wochen-Issue, nur auf dem Handy geladen.
- **Änderungen werden nur vorgemerkt.** Oben steht, was noch nicht verschickt ist. Erst
  **„Neu berechnen und senden“** startet den Workflow; nach etwa einer Minute erscheint das Ergebnis.
- **„Versenden ab heute“**: sonst gelten die Nachrichten für die ganze Woche.
- **„Aushilfe mit Namen eintragen“**: Vorname, Tage, von–bis – schreibt einen Kommentar
  (`Greta springt ein am Mittwoch 08:00-16:30`) in die Wochen-Issue.
- **„Letzter Lauf“**: was verschickt wurde (zum Aufklappen), Hinweise und Fehler.

Was die Häkchen und Kommentare genau bewirken, steht in `docs/handy.md` im Hauptrepo.

## Technik

- Reine statische Seite ohne Build: `index.html`, `style.css`, `logic.js` (reine Funktionen),
  `app.js` (Oberfläche und GitHub-API), `sw.js` (Offline-Cache nur für die App-Dateien, nie für
  Daten), `manifest.webmanifest`.
- Die App liest die Liste zum Abhaken aus der Issue-Beschreibung (jede Zeile hat einen unsichtbaren
  Schlüssel `<!-- krank:Anna:1 -->`) und die unsichtbaren Zusammenfassungen in den Antworten des
  Workflows (`<!-- wochenstand … -->`, `<!-- wochenansicht … -->`). Ändert sich dieses Format im
  Hauptrepo (`dienstplan/week_issue.py`), muss `logic.js` mitziehen.
- Beim Setzen eines Häkchens lädt die App die Beschreibung frisch und ändert nur diese eine Zeile.
- Content-Security-Policy: Skripte und Styles nur von der eigenen Seite, Netzwerk nur zu
  `api.github.com`.
- Tests: `node --test` (Logik), läuft auch als GitHub-Workflow. `vorschau/phone.html` zeigt die App mit
  erfundenen Daten in Handybreite (`vorschau/fake-github.js` ersetzt die GitHub-API), ohne Schlüssel.
