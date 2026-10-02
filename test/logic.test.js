// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const BG = require('../logic.js');

// Shaped like checklist_body() in dienstplan/week_issue.py (fictional names).
const BODY = [
  'Wochen-Issue: Änderungen dieser Woche **abhaken** …',
  '',
  '### Montag, 02.11.',
  '',
  '- [ ] Anna 08:00–14:00 krank <!-- krank:Anna:1 -->',
  '- [x] Bea 08:15–15:30 krank <!-- krank:Bea:1 -->',
  '- [ ] Offene Aushilfe 12:00–16:00: keine verfügbar <!-- keine-aushilfe:1 -->',
  '- [ ] Offene Aushilfe 12:00–16:00: gefunden <!-- aushilfe-gefunden:1 -->',
  '',
  '### Dienstag, 03.11.',
  '',
  'Keine Schichten.',
  '',
  '### Woche',
  '',
  '- [ ] Versenden ab heute (sonst die ganze Woche) <!-- ab-heute -->',
  '- [ ] Neu berechnen und senden (Häkchen setzen oder entfernen) <!-- neu-berechnen -->',
  '- [ ] Alles zurücksetzen – frischer Stand aus Famly <!-- zuruecksetzen -->',
  '',
].join('\n');

const bot = (id, body) => ({ id, body, user: { type: 'Bot' } });
const person = (id, body) => ({ id, body, user: { type: 'User' } });

test('parseChecklist reads keys, marks, labels and days', () => {
  const items = BG.parseChecklist(BODY);
  assert.equal(items.length, 7);
  assert.deepEqual(items[0], { key: 'krank:Anna:1', checked: false, label: 'Anna 08:00–14:00 krank', day: 1 });
  assert.equal(items[1].checked, true);
  assert.deepEqual(items.filter((item) => item.day === 0).map((item) => item.key), ['ab-heute', 'neu-berechnen', 'zuruecksetzen']);
  assert.deepEqual(BG.parseChecklist('Ohne Liste\n- [x] nur Text'), []);
});

test('setChecks changes only the marks and keeps line endings', () => {
  const changed = BG.setChecks(BODY, { 'krank:Anna:1': true, 'krank:Bea:1': false });
  const items = BG.parseChecklist(changed);
  assert.equal(items[0].checked, true);
  assert.equal(items[1].checked, false);
  assert.equal(changed.replace('- [x] Anna', '- [ ] Anna').replace('- [ ] Bea', '- [x] Bea'), BODY);
  const crlf = BG.setChecks(BODY.replace(/\n/g, '\r\n'), { 'neu-berechnen': true });
  assert.ok(crlf.includes('- [x] Neu berechnen und senden') && crlf.includes('\r\n') && !/[^\r]\n/.test(crlf));
  assert.throws(() => BG.setChecks(BODY, { 'krank:Dora:2': true }), /krank:Dora:2/);
});

test('latestMarker takes the newest bot reply with a valid marker', () => {
  const comments = [
    bot(1, '```x```\n<!-- wochenstand {"haken": [], "kommentar": 0, "zurueckgesetzt": false} -->'),
    person(2, '<!-- wochenstand {"haken": ["x"]} -->'),
    bot(3, '<!-- wochenansicht {"woche": "2026 KW45", "tage": {"1": "🟠 Mo --\\u003e"}} -->'),
    bot(4, 'kaputt <!-- wochenstand {kaputt} -->'),
  ];
  assert.equal(BG.latestMarker(comments, 'wochenstand').comment.id, 1);
  assert.equal(BG.latestMarker(comments, 'wochenansicht').data.tage['1'], '🟠 Mo -->');
  assert.equal(BG.latestMarker([person(1, 'x')], 'wochenstand'), null);
});

test('pendingChanges compares with the stored state', () => {
  const items = BG.parseChecklist(BG.setChecks(BODY, { 'ab-heute': true }));
  const comments = [
    bot(10, '<!-- wochenstand {"haken": ["krank:Anna:1", "ab-heute"], "kommentar": 9, "zurueckgesetzt": false} -->'),
    person(11, 'Greta springt ein am Montag 08:00-12:00'),
  ];
  const pending = BG.pendingChanges(items, comments);
  assert.deepEqual(pending.added.map((item) => item.key), ['krank:Bea:1']);
  assert.deepEqual(pending.removed.map((item) => item.key), ['krank:Anna:1']);
  assert.deepEqual(pending.comments.map((comment) => comment.id), [11]);
  // Without a stored state: everything checked is new, comments after the last bot reply are new.
  const withoutState = BG.pendingChanges(items, [person(1, 'alt'), bot(2, 'Antwort'), person(3, 'neu')]);
  assert.deepEqual(withoutState.added.map((item) => item.key), ['krank:Bea:1']);
  assert.deepEqual(withoutState.comments.map((comment) => comment.id), [3]);
});

test('ISO weeks and titles', () => {
  assert.deepEqual(BG.isoWeek(new Date(2026, 9, 1)), { year: 2026, week: 40 });
  assert.deepEqual(BG.isoWeek(new Date(2027, 0, 1)), { year: 2026, week: 53 });
  assert.equal(BG.dateOf(2026, 45, 1).toISOString().slice(0, 10), '2026-11-02');
  assert.equal(BG.dateOf(2026, 53, 5).toISOString().slice(0, 10), '2027-01-01');
  assert.equal(BG.weeksInYear(2026), 53);
  assert.equal(BG.weeksInYear(2027), 52);
  assert.equal(BG.weekTitle(2026, 5), '2026 KW05');
  assert.deepEqual(BG.parseWeekTitle('2026 KW42', 2025), { year: 2026, week: 42 });
  assert.deepEqual(BG.parseWeekTitle('Woche KW7', 2026), { year: 2026, week: 7 });
  assert.equal(BG.parseWeekTitle('Dienstplan', 2026), null);
});

test('substituteComment builds the format the week issue parses', () => {
  assert.equal(BG.substituteComment('greta', [3], '08:00', '16:30'), 'Greta springt ein am Mittwoch 08:00-16:30');
  assert.equal(BG.substituteComment('Greta', [5, 1, 3], '09:00', '12:00'), 'Greta springt ein am Montag, Mittwoch und Freitag 09:00-12:00');
  assert.throws(() => BG.substituteComment('Greta Meier', [1], '08:00', '12:00'), /Vornamen/);
  assert.throws(() => BG.substituteComment('Aushilfe', [1], '08:00', '12:00'), /echten Namen/);
  assert.throws(() => BG.substituteComment('Greta', [], '08:00', '12:00'), /Tag/);
  assert.throws(() => BG.substituteComment('Greta', [1], '12:00', '08:00'), /vor/);
});

test('slotSubstitutes finds a Zusage overlapping the slot since the last reset', () => {
  const bot = { type: 'Bot' };
  const person = { type: 'User' };
  const label = 'Offene Aushilfe 12:00–16:00: gefunden';
  const comments = [
    { id: 1, user: person, body: 'Dora springt ein am Mittwoch 12:00-16:00' },
    { id: 2, user: bot, body: '<!-- wochenstand {"haken": [], "kommentar": 1, "zurueckgesetzt": true} -->' },
    { id: 3, user: person, body: 'Greta springt ein am Montag und Mittwoch 8:00-13:00' },
    { id: 4, user: person, body: 'Hedi springt ein am Mittwoch 16:00-18:00' },
    { id: 5, user: bot, body: 'Greta springt ein am Dienstag 12:00-16:00' },
  ];
  assert.deepEqual(BG.slotSubstitutes(comments, 3, label), [{ name: 'Greta', from: '08:00', to: '13:00' }]);
  assert.deepEqual(BG.slotSubstitutes(comments, 2, label), []);
  assert.deepEqual(BG.slotSubstitutes(comments, 1, label).map((zusage) => zusage.name), ['Greta']);
});

test('timeOptions and splitDayLine', () => {
  assert.deepEqual(BG.timeOptions('07:00', '08:00', 30), ['07:00', '07:30', '08:00']);
  assert.deepEqual(BG.splitDayLine('🟠 Mo 08:00 - 17:00 | ab 12:00: max. 8 Kinder'), { status: 'orange', text: '08:00 - 17:00 | ab 12:00: max. 8 Kinder' });
  assert.equal(BG.splitDayLine('⚠️ Fr 08:00 - 15:00 | Unzulässiger Dienstplan').status, 'warnung');
  assert.deepEqual(BG.splitDayLine(undefined), { status: '', text: '' });
});

test('parentDutyComment builds the format the week issue parses', () => {
  assert.equal(BG.parentDutyComment([3], '08:00', '12:30'), 'Elterndienst am Mittwoch 08:00-12:30');
  assert.equal(BG.parentDutyComment([4, 1], '12:30', '16:00'), 'Elterndienst am Montag und Donnerstag 12:30-16:00');
  assert.throws(() => BG.parentDutyComment([], '08:00', '12:00'), /Tag/);
  assert.throws(() => BG.parentDutyComment([1], '12:00', '08:00'), /vor/);
});

test('latestChildren takes the newest list from either marker', () => {
  const view = (time, name) => JSON.stringify({ zeitpunkt: time, kinderliste: { 1: { anwesend: [name], abwesend: [] } } });
  const comments = [
    bot(1, `<!-- wochenansicht ${view('2026-11-02T07:40', 'Jonas')} -->`),
    bot(2, `<!-- wochenkinder ${view('2026-11-02T09:15', 'Lia')} -->`),
    person(3, 'Greta springt ein am Montag 08:00-12:00'),
  ];
  assert.deepEqual(BG.latestChildren(comments), { lists: { 1: { anwesend: ['Lia'], abwesend: [] } }, zeitpunkt: '2026-11-02T09:15' });
  comments.push(bot(4, `<!-- wochenstand {"haken": []} -->\n<!-- wochenansicht ${view('2026-11-02T10:00', 'Mats')} -->`));
  assert.equal(BG.latestChildren(comments).lists[1].anwesend[0], 'Mats');
  assert.equal(BG.latestChildren([person(1, 'x')]), null);
  assert.equal(BG.KEYS.children, 'kinder-aktualisieren');
  assert.ok(BG.SETTING_KEYS.has('kinder-aktualisieren'));
});
