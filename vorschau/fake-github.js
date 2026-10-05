// For vorschau/preview.html only: replaces fetch() with a fake GitHub API holding a fictional week, so the
// app can be looked at (and screenshotted) without a token or real data. Writes change the fake data.
(function () {
  'use strict';
  const body = [
    'Wochen-Issue: Änderungen dieser Woche **abhaken** (oder ein Häkchen wieder entfernen) – verschickt wird',
    'erst, wenn ganz unten **„Neu berechnen und senden“** umgeschaltet wird, und dann nur das Neue.',
    '',
    '### Montag, 02.11.', '',
    '- [x] Anna 08:00–14:00 krank <!-- krank:Anna:1 -->',
    '- [x] Für Aushilfen freigegeben: Mo 08:30–14:00 <!-- freigabe:krank:Anna:1:08:30-14:00 -->',
    '- [ ] Bea 08:15–15:30 krank <!-- krank:Bea:1 -->',
    '- [ ] Dora 09:00–17:00 krank <!-- krank:Dora:1 -->', '',
    '### Dienstag, 03.11.', '',
    '- [ ] Anna 08:00–11:30 krank <!-- krank:Anna:2 -->',
    '- [ ] Bea 08:15–16:00 krank <!-- krank:Bea:2 -->',
    '- [ ] Offene Aushilfe 12:00–16:00: keine verfügbar <!-- keine-aushilfe:2 -->',
    '- [x] Offene Aushilfe 12:00–16:00: gefunden <!-- aushilfe-gefunden:2 -->', '',
    '### Mittwoch, 04.11.', '',
    '- [ ] Dora 08:00–16:00 krank <!-- krank:Dora:3 -->',
    '- [ ] Bea 09:00–16:00 krank <!-- krank:Bea:3 -->', '',
    '### Donnerstag, 05.11.', '',
    'Keine Schichten.', '',
    '### Freitag, 06.11.', '',
    '- [ ] Anna 08:00–14:00 krank <!-- krank:Anna:5 -->',
    '- [ ] Offene Aushilfe 09:00–15:00: keine verfügbar <!-- keine-aushilfe:5 -->',
    '- [ ] Offene Aushilfe 09:00–15:00: gefunden <!-- aushilfe-gefunden:5 -->',
    '- [x] Für Aushilfen freigegeben: Fr 09:00–15:00 <!-- freigabe:aushilfe:5:09:00-15:00 -->', '',
    '### Woche', '',
    '- [ ] Versenden ab heute (sonst die ganze Woche) <!-- ab-heute -->',
    '- [ ] Nur berechnen – Vorschau, nichts verschickt (Häkchen setzen oder entfernen) <!-- nur-berechnen -->',
    '- [ ] Neu berechnen und senden (Häkchen setzen oder entfernen) <!-- neu-berechnen -->',
    '- [ ] Kinderbelegung aktualisieren – nur die Kinder je Tag, nichts verschickt (Häkchen setzen oder entfernen) <!-- kinder-aktualisieren -->',
    '- [ ] Alles zurücksetzen – frischer Stand aus Famly <!-- zuruecksetzen -->', '',
  ].join('\n');
  const view = {
    woche: '2026 KW45', zeitpunkt: '2026-11-02T07:40', modus: 'recalculate', ab_heute: false,
    tage: {
      1: '🟠 Mo 08:15 - 17:00 | ab 14:00: 🔺 max. 8 Kinder (10 angemeldet) | 🍽️  Mittagsdienst nötig',
      2: '🟢 Di 08:00 - 16:00 | 🍽️  Mittagsdienst nötig',
      3: '🟢 Mi 08:00 - 16:00',
      4: '🔴 Do Einrichtung geschlossen (Brückentag)',
      5: '🟢 Fr 08:00 - 15:00 | 🍽️  Mittagsdienst nötig',
    },
    kinder: { 1: 10, 2: 10, 3: 9, 4: 0, 5: 9 },
    plan: {
      Anna: { 1: '🤒 krank', 2: '08:00-11:30', 3: '-', 4: '-', 5: '08:00-14:00' },
      Bea: { 1: '08:15-15:30', 2: '08:15-16:00', 3: '09:00-16:00', 4: '-', 5: '-' },
      Dora: { 1: '09:00-17:00', 2: '-', 3: '08:00-16:00', 4: '-', 5: '-' },
      Aushilfe: { 1: '-', 2: '✅ besetzt', 3: '-', 4: '-', 5: '09:00-15:00' },
      Greta: { 1: '-', 2: '-', 3: '-', 4: '-', 5: '-' },
      Elterndienst: { 1: '-', 2: '-', 3: '08:00-12:00', 4: '-', 5: '-' },
    },
    kinderliste: {
      1: { anwesend: ['Jonas', 'Lia (bis 14:00)', 'Mats', 'Nele', 'Ole', 'Pia', 'Rosa', 'Theo', 'Vito', 'Wanda', 'Yuna*'], abwesend: ['Kian', 'Smilla'] },
      2: { anwesend: ['Jonas', 'Lia (bis 14:00)', 'Mats', 'Nele', 'Ole', 'Pia', 'Rosa', 'Theo', 'Vito', 'Wanda'], abwesend: [] },
      3: { anwesend: ['Jonas', 'Mats', 'Nele', 'Ole', 'Pia', 'Rosa', 'Theo', 'Vito', 'Wanda', 'Yuna*'], abwesend: ['Lia'] },
      4: { anwesend: [], abwesend: [] },
      5: { anwesend: ['Jonas', 'Lia (bis 14:00)', 'Mats', 'Nele', 'Ole', 'Pia', 'Rosa', 'Theo', 'Vito'], abwesend: ['Wanda'] },
    },
    aenderungen: ['Anna krank am Montag', 'Aushilfe gefunden am Dienstag'],
    fehler: [],
    versendet: true,
    nachrichten: [
      { titel: 'Kurzfristiger Ausfall KW45', text: 'Aufgrund des kurzfristigen Ausfalls von "Anna" ergibt sich folgende Aktualisierung:\n🟠 Mo 08:15 - 17:00 | ab 14:00: 🔺 max. 8 Kinder (10 angemeldet)\nWir versuchen noch eine Aushilfe zu organisieren.' },
      { titel: 'Mittagsdienst KW45', text: 'Wer kann den Mittagsdienst am Mo, 02.11. übernehmen?' },
    ],
    hinweise: ['⚠ Offene Aushilfe Fr, 06.11. 09:00–15:00 bringt keine Verbesserung – ohne sie müssten nicht mehr Kinder zu Hause bleiben.'],
  };
  // Hanna's Zusage for Thursday and the Elterndienst on Tuesday were sent and their comments are
  // gone: shown as withdrawn. Wednesday's Elterndienst is still there (with ✕).
  const stand = {
    haken: ['krank:Anna:1'], kommentar: 101, zurueckgesetzt: false, zusagen: ['Hanna:4:09:00-15:00'],
    elterndienste: ['2:08:00-12:00', '3:08:00-12:00'],
  };
  const issue = { number: 45, title: '2026 KW45', state: 'open', body, html_url: 'https://github.com/' };
  const comments = [
    { id: 100, user: { type: 'User' }, body: 'Elterndienst am Mittwoch 08:00-12:00' },
    { id: 101, user: { type: 'Bot' }, body: '```\n…\n```\n<!-- wochenstand ' + JSON.stringify(stand) + ' -->\n<!-- wochenansicht ' + JSON.stringify(view) + ' -->' },
    { id: 102, user: { type: 'User' }, body: 'Greta springt ein am Mittwoch 08:00-12:00' },
    { id: 103, user: { type: 'User' }, body: 'Dora springt ein am Freitag 09:00-15:00' },
  ];
  const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, options = {}) => {
    const path = new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const method = options.method || 'GET';
    if (path === '/issues' && method === 'GET') return json([issue]);
    if (path === '/issues/45' && method === 'GET') return json(issue);
    if (path === '/issues/45' && method === 'PATCH') { issue.body = JSON.parse(options.body).body; return json(issue); }
    if (path === '/issues/45/comments' && method === 'GET') return json(comments);
    if (path === '/issues/45/comments' && method === 'POST') {
      const comment = { id: comments.length + 200, user: { type: 'User' }, body: JSON.parse(options.body).body };
      comments.push(comment);
      return json(comment, 201);
    }
    const single = path.match(/^\/issues\/comments\/(\d+)$/);
    const found = single && comments.find((comment) => comment.id === Number(single[1]));
    if (found && method === 'GET') return json(found);
    if (found && method === 'PATCH') { found.body = JSON.parse(options.body).body; return json(found); }
    if (found && method === 'DELETE') { comments.splice(comments.indexOf(found), 1); return Promise.resolve(new Response(null, { status: 204 })); }
    return json({ message: 'Not Found' }, 404);
  };
  // Preview only: open the children lists, so a screenshot shows them.
  setTimeout(() => document.querySelectorAll('details.children').forEach((details) => { details.open = true; }), 800);
  try { localStorage.setItem('bg_token', 'vorschau'); } catch (error) { /* preview only */ }
})();
