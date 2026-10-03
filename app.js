// The app: reads and edits the week issue of the main repository through the GitHub API. All data
// is loaded at runtime with the user's own token (stored only on this device); nothing about the
// kita lives in this repository. Pure helpers are in logic.js (window.BG).
(function () {
  'use strict';

  const { KEYS, DAYS, SHORT_DAYS } = BG;
  const DEFAULT_REPO = 'lienertt/blaue-giraffe';
  const POLL_MS = 5000;
  const POLL_LIMIT_MS = 4 * 60 * 1000;

  // localStorage can be missing or throw (private mode, blocked storage): the app then just asks again.
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch (error) { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (error) { /* not persisted */ } },
    remove(key) { try { localStorage.removeItem(key); } catch (error) { /* nothing to remove */ } },
  };

  const state = {
    token: store.get('bg_token') || '',
    repo: store.get('bg_repo') || DEFAULT_REPO,
    issues: [],
    number: Number(store.get('bg_issue')) || null,
    issue: null,
    comments: [],
    items: [],
    busy: false,
    waiting: null,
    error: '',
    info: '',
    // The checklist key below which the release form is open ("krank:Anna:3", "aushilfe-gefunden:3").
    releaseForm: null,
  };

  const $ = (selector) => document.querySelector(selector);

  /** Creates an element; text is always set as text, never as HTML. */
  function h(tag, attrs, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value === false || value === null || value === undefined) continue;
      if (name === 'class') element.className = value;
      else if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
      else if (name === 'checked' || name === 'disabled' || name === 'selected') element[name] = Boolean(value);
      else element.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  }

  // ---------- GitHub API ----------

  async function gh(path, options = {}) {
    const response = await fetch(`https://api.github.com/repos/${state.repo}${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${state.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).message || ''; } catch (error) { /* no JSON body */ }
      if (response.status === 401) throw new Error('Der Zugangsschlüssel ist ungültig oder abgelaufen – bitte in den Einstellungen neu eintragen.');
      if (response.status === 403 || response.status === 404) {
        throw new Error(`Kein Zugriff (${response.status}): Hat der Schlüssel „Issues: Read and write“ für ${state.repo}?`);
      }
      throw new Error(`GitHub meldet ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async function getAll(path) {
    let all = [];
    for (let page = 1; ; page += 1) {
      const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      all = all.concat(batch);
      if (batch.length < 100) return all;
    }
  }

  // ---------- Loading ----------

  function weekOf(issue) {
    return BG.parseWeekTitle(issue.title, new Date().getFullYear());
  }

  function compareWeeks(a, b) {
    return a.year - b.year || a.week - b.week;
  }

  async function loadIssues() {
    const issues = (await getAll('/issues?labels=woche&state=all')).filter((issue) => !issue.pull_request && weekOf(issue));
    issues.sort((a, b) => compareWeeks(weekOf(b), weekOf(a)) || a.number - b.number);
    state.issues = issues;
    if (!issues.some((issue) => issue.number === state.number)) state.number = defaultIssue();
  }

  /** The open issue of the current week, else of the next one, else the newest open one. */
  function defaultIssue() {
    const now = BG.isoWeek(new Date());
    const next = BG.isoWeek(new Date(Date.now() + 7 * 86400000));
    const open = state.issues.filter((issue) => issue.state === 'open');
    const find = (week) => open.find((issue) => compareWeeks(weekOf(issue), week) === 0);
    const chosen = find(now) || find(next) || open[0] || state.issues[0];
    return chosen ? chosen.number : null;
  }

  async function loadWeek() {
    if (!state.number) {
      state.issue = null;
      state.comments = [];
      state.items = [];
      return;
    }
    const [issue, comments] = await Promise.all([gh(`/issues/${state.number}`), getAll(`/issues/${state.number}/comments`)]);
    state.issue = issue;
    state.comments = comments;
    state.items = BG.parseChecklist(issue.body || '');
    store.set('bg_issue', String(state.number));
  }

  async function reload(options = {}) {
    if (!state.token) {
      render();
      openSettings();
      return;
    }
    await run(async () => {
      if (options.issues !== false) await loadIssues();
      await loadWeek();
    });
  }

  /** Runs an action with a busy state and shows its error, if any. */
  async function run(action) {
    state.busy = true;
    state.error = '';
    render();
    try {
      await action();
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  // ---------- Actions ----------

  /** Sets checkmarks on the freshly loaded description, so nothing someone else changed is lost. */
  async function applyChecks(changes) {
    await changeBody((body) => BG.setChecks(body, changes));
  }

  /** Changes the freshly loaded description with `change(body)` and saves it. */
  async function changeBody(change) {
    const fresh = await gh(`/issues/${state.number}`);
    const body = change(fresh.body || '');
    await gh(`/issues/${state.number}`, { method: 'PATCH', body: { body } });
    fresh.body = body;
    state.issue = fresh;
    state.items = BG.parseChecklist(body);
  }

  /**
   * Releases a slot for the Aushilfen page: adds a checked release line below the shift's line
   * (or checks it again if it is there). Visible on the page at once; nothing is sent.
   */
  function addRelease(afterKey, source, day, ranges, start, end) {
    try {
      BG.checkRelease(ranges, start, end);
    } catch (error) {
      state.error = error.message;
      render();
      return;
    }
    const key = BG.releaseKey(source, day, start, end);
    run(async () => {
      await changeBody((body) => (body.includes(`<!-- ${key} -->`)
        ? BG.setChecks(body, { [key]: true })
        : BG.addLineAfter(body, afterKey, BG.releaseLine(key))));
      state.releaseForm = null;
      state.info = `Für Aushilfen freigegeben: ${DAYS[day - 1]} ${start}–${end} – sofort auf der Aushilfen-Seite sichtbar.`;
    });
  }

  function deleteRelease(key) {
    run(() => changeBody((body) => BG.removeLine(body, key)));
  }

  function toggle(key, checked) {
    run(() => applyChecks({ [key]: checked }));
  }

  function itemChecked(key) {
    const item = state.items.find((entry) => entry.key === key);
    return Boolean(item && item.checked);
  }

  function lastBotId() {
    return Math.max(0, ...state.comments.filter(BG.isBot).map((comment) => comment.id));
  }

  /** Toggles a trigger checkbox and waits for the workflow's reply. */
  function trigger(key, label) {
    run(async () => {
      const since = lastBotId();
      await applyChecks({ [key]: !itemChecked(key) });
      startWaiting(since, label);
    });
  }

  function startWaiting(sinceBotId, label) {
    state.info = '';
    state.waiting = { since: Date.now(), botId: sinceBotId, label };
    setTimeout(poll, POLL_MS);
  }

  async function poll() {
    if (!state.waiting) return;
    try {
      const comments = await getAll(`/issues/${state.number}/comments`);
      if (comments.some((comment) => BG.isBot(comment) && comment.id > state.waiting.botId)) {
        const label = state.waiting.label;
        state.waiting = null;
        await reload({ issues: label === 'Woche angelegt' });
        state.info = `${label}: fertig.`;
        render();
        return;
      }
    } catch (error) {
      state.error = error.message;
    }
    if (Date.now() - state.waiting.since > POLL_LIMIT_MS) {
      state.waiting = null;
      state.error = 'Nach 4 Minuten noch keine Antwort vom Workflow – bitte in GitHub nachsehen (Link unten).';
      render();
      return;
    }
    render();
    setTimeout(poll, POLL_MS);
  }

  function setSlot(day, value) {
    const changes = {};
    for (const [key, wanted] of [[`keine-aushilfe:${day}`, value === 'keine'], [`aushilfe-gefunden:${day}`, value === 'gefunden']]) {
      if (state.items.some((item) => item.key === key)) changes[key] = wanted;
    }
    run(() => applyChecks(changes));
  }

  function rememberName(name) {
    const names = knownNames().filter((known) => known.toLowerCase() !== name.toLowerCase());
    store.set('bg_names', JSON.stringify([name, ...names].slice(0, 12)));
  }

  function knownNames() {
    try { return JSON.parse(store.get('bg_names') || '[]'); } catch (error) { return []; }
  }

  async function submitSubstitute(form) {
    const days = [...form.querySelectorAll('input[name="tag"]:checked')].map((input) => Number(input.value));
    let text;
    try {
      text = BG.substituteComment(form.elements.name.value, days, form.elements.von.value, form.elements.bis.value);
    } catch (error) {
      state.error = error.message;
      render();
      return;
    }
    await run(async () => {
      const comment = await gh(`/issues/${state.number}/comments`, { method: 'POST', body: { body: text } });
      state.comments.push(comment);
      rememberName(text.split(' ')[0]);
      state.info = `Eingetragen: „${text}“ – wird beim nächsten „Neu berechnen“ verschickt.`;
    });
  }

  /** Takes one day of a Zusage back: edits its comment, or deletes it if nothing else is left. */
  function removeZusage(zusage, day) {
    const when = `${DAYS[day - 1]} ${zusage.from}–${zusage.to}`;
    if (!confirm(`Zusage von ${zusage.name} am ${when} zurücknehmen? Verschickt wird erst beim nächsten „Neu berechnen“.`)) return;
    run(async () => {
      const path = `/issues/comments/${zusage.commentId}`;
      const fresh = await gh(path);
      const body = BG.withoutSubstituteDay(fresh.body || '', zusage.index, day);
      if (body) await gh(path, { method: 'PATCH', body: { body } });
      else await gh(path, { method: 'DELETE' });
      await loadWeek();
      state.info = `Zusage von ${zusage.name} am ${when} zurückgenommen – der Slot ist wieder offen. Verschickt wird beim nächsten „Neu berechnen“.`;
    });
  }

  async function submitParentDuty(form) {
    const days = [...form.querySelectorAll('input[name="tag"]:checked')].map((input) => Number(input.value));
    let text;
    try {
      text = BG.parentDutyComment(days, form.elements.von.value, form.elements.bis.value);
    } catch (error) {
      state.error = error.message;
      render();
      return;
    }
    await run(async () => {
      const comment = await gh(`/issues/${state.number}/comments`, { method: 'POST', body: { body: text } });
      state.comments.push(comment);
      state.info = `Eingetragen: „${text}“ – wird beim nächsten „Neu berechnen“ berücksichtigt.`;
    });
  }

  async function createWeek(year, week) {
    const title = BG.weekTitle(year, week);
    const existing = state.issues.find((issue) => issue.state === 'open' && compareWeeks(weekOf(issue), { year, week }) === 0);
    if (existing) {
      state.number = existing.number;
      state.info = `Für ${title} gibt es schon eine offene Wochen-Issue (#${existing.number}).`;
      await reload({ issues: false });
      return;
    }
    await run(async () => {
      const issue = await gh('/issues', { method: 'POST', body: { title, labels: ['woche'] } });
      state.number = issue.number;
      await loadIssues();
      await loadWeek();
      startWaiting(0, 'Woche angelegt');
    });
  }

  // ---------- Rendering ----------

  function render() {
    renderWeekSelect();
    const main = $('#main');
    main.replaceChildren(...renderMain());
    document.body.classList.toggle('busy', state.busy);
  }

  function renderWeekSelect() {
    const select = $('#week-select');
    select.replaceChildren(
      ...state.issues.map((issue) => h('option', { value: String(issue.number), selected: issue.number === state.number },
        `${issue.title}${issue.state === 'closed' ? ' (geschlossen)' : ''}`)),
    );
    select.disabled = !state.issues.length || state.busy;
  }

  function renderMain() {
    const blocks = [];
    if (state.error) blocks.push(h('div', { class: 'banner error', role: 'alert' }, state.error));
    if (state.waiting) {
      blocks.push(h('div', { class: 'banner waiting', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        `${state.waiting.label} – der Workflow rechnet, das dauert etwa eine Minute …`));
    } else if (state.info) {
      blocks.push(h('div', { class: 'banner info', role: 'status' }, state.info));
    }
    if (!state.token) {
      blocks.push(h('section', { class: 'card' }, h('h2', {}, 'Willkommen'),
        h('p', {}, 'Bitte zuerst in den Einstellungen (⚙) einen GitHub-Zugangsschlüssel eintragen.')));
      return blocks;
    }
    if (!state.issue) {
      blocks.push(h('section', { class: 'card' }, h('h2', {}, 'Keine Wochen-Issue'),
        h('p', {}, state.busy ? 'Lädt …' : 'Es gibt noch keine Wochen-Issue. Mit „+ Woche“ eine anlegen.')));
      return blocks;
    }
    const viewMarker = BG.latestMarker(state.comments, 'wochenansicht');
    const view = viewMarker ? viewMarker.data : null;
    blocks.push(renderControls());
    if (!state.items.length) {
      blocks.push(h('section', { class: 'card' }, h('p', {},
        'Diese Wochen-Issue hat noch keine Liste zum Abhaken. Der Workflow schreibt sie beim Anlegen einer Woche; ältere Issues bekommen sie nicht automatisch.')));
    }
    const week = weekOf(state.issue);
    const childLists = BG.latestChildren(state.comments);
    for (let day = 1; day <= 5; day += 1) blocks.push(renderDay(day, week, view, childLists));
    blocks.push(renderSubstituteForm());
    blocks.push(renderParentDutyForm());
    blocks.push(renderLastRun(view));
    blocks.push(h('p', { class: 'center muted small' },
      h('a', { href: state.issue.html_url, target: '_blank', rel: 'noopener' }, `In GitHub öffnen (#${state.issue.number})`)));
    return blocks;
  }

  function renderControls() {
    const pending = BG.pendingChanges(state.items, state.comments, weekOf(state.issue));
    const count = pending.added.length + pending.removed.length + pending.comments.length
      + pending.withdrawn.length + pending.changed.length;
    const disabled = state.busy || Boolean(state.waiting) || !state.items.length;
    const fromTodayItem = state.items.find((item) => item.key === KEYS.fromToday);
    const lines = [
      ...pending.added.map((item) => `+ ${describe(item)}`),
      ...pending.removed.map((item) => `− ${describe(item)} (zurückgenommen, ohne eigene Nachricht)`),
      ...pending.comments.map((comment) => `💬 ${comment.body.trim().slice(0, 120)}`),
      ...pending.withdrawn.map(({ name, day }) => `− Zusage ${name} ${SHORT_DAYS[day - 1]} zurückgenommen`),
      ...pending.changed.map((entry) => {
        const [name, day, ...times] = entry.split(':');
        return `✏️ Zusage geändert: ${name} ${SHORT_DAYS[Number(day) - 1]} ${times.join(':').replace('-', '–')}`;
      }),
    ];
    return h('section', { class: 'card controls' },
      state.issue.state === 'closed' ? h('p', { class: 'muted small' }, 'Diese Wochen-Issue ist geschlossen.') : null,
      h('div', { class: 'pending' },
        count
          ? [h('p', { class: 'pending-title' }, `${count} ${count === 1 ? 'Änderung' : 'Änderungen'} noch nicht verschickt:`),
            h('ul', { class: 'pending-list' }, lines.map((line) => h('li', {}, line)))]
          : h('p', { class: 'muted' }, 'Alles verschickt – keine offenen Änderungen.')),
      fromTodayItem ? h('label', { class: 'switch-row' },
        h('span', {}, 'Versenden ab heute', h('small', { class: 'muted block' }, 'sonst für die ganze Woche')),
        h('input', { type: 'checkbox', class: 'switch', checked: fromTodayItem.checked, disabled,
          onchange: (event) => toggle(KEYS.fromToday, event.target.checked) })) : null,
      h('button', { type: 'button', class: 'primary wide', disabled, onclick: () => trigger(KEYS.recalc, 'Neu berechnet') },
        count ? `Neu berechnen und senden (${count})` : 'Neu berechnen und senden'),
      // Only in week issues whose checklist has the line (the workflow adds it to older ones on its next run).
      state.items.some((item) => item.key === KEYS.preview)
        ? h('button', { type: 'button', class: 'secondary wide', disabled,
          onclick: () => trigger(KEYS.preview, 'Vorschau berechnet') }, '👁 Nur berechnen (Vorschau)')
        : null,
      state.items.some((item) => item.key === KEYS.children)
        ? h('button', { type: 'button', class: 'secondary wide', disabled,
          onclick: () => trigger(KEYS.children, 'Kinderbelegung aktualisiert') }, '👶 Kinderbelegung aktualisieren')
        : null,
      h('button', { type: 'button', class: 'secondary danger wide', disabled,
        onclick: () => {
          if (confirm('Alle Häkchen und Kommentare dieser Woche verwerfen und die Liste frisch aus Famly schreiben? Verschickt wird dabei nichts.')) {
            trigger(KEYS.reset, 'Zurückgesetzt');
          }
        } }, 'Alles zurücksetzen'));
  }

  function describe(item) {
    const day = item.day ? `${SHORT_DAYS[item.day - 1]}: ` : '';
    return `${day}${item.label}`;
  }

  function renderDay(day, week, view, childLists) {
    const items = state.items.filter((item) => item.day === day);
    const dateText = week ? formatDate(BG.dateOf(week.year, week.week, day)) : '';
    const line = view && view.tage ? view.tage[String(day)] : '';
    const { status, text } = BG.splitDayLine(line);
    const children = view && view.kinder ? view.kinder[String(day)] : undefined;
    const disabled = state.busy || Boolean(state.waiting);
    const sickItems = items.filter((item) => item.key.startsWith('krank:'));
    const checklistNames = new Set(sickItems.map((item) => item.key.split(':')[1]));
    const others = view && view.plan
      ? Object.entries(view.plan)
        .filter(([name, cells]) => !checklistNames.has(name) && name !== 'Aushilfe' && cells[String(day)] && cells[String(day)] !== '-')
        .map(([name, cells]) => h('li', { class: 'row readonly' }, h('span', {}, name), h('span', { class: 'muted' }, cells[String(day)])))
      : [];
    const slotKeys = { keine: `keine-aushilfe:${day}`, gefunden: `aushilfe-gefunden:${day}` };
    const slotItem = items.find((item) => item.key === slotKeys.keine || item.key === slotKeys.gefunden);
    const slotValue = itemChecked(slotKeys.keine) ? 'keine' : itemChecked(slotKeys.gefunden) ? 'gefunden' : 'offen';
    // A Zusage (comment "<Name> springt ein …", e.g. from the Aushilfen page) takes the slot without a checkmark.
    const zusagen = slotItem ? BG.slotSubstitutes(state.comments, day, slotItem.label) : [];
    return h('section', { class: `card day ${status}` },
      h('div', { class: 'day-head' },
        h('h2', {}, `${DAYS[day - 1]}${dateText ? `, ${dateText}` : ''}`),
        children !== undefined ? h('span', { class: 'muted small' }, `${children} Kinder`) : null),
      line ? h('p', { class: `status ${status}` }, text) : h('p', { class: 'muted small' }, 'Noch keine Auswertung – „Neu berechnen“ antippen.'),
      h('ul', { class: 'rows' },
        sickItems.flatMap((item) => [
          h('li', { class: `row${item.checked ? ' sick' : ''}` },
            h('span', {}, item.label.replace(/\s+krank$/, '')),
            h('label', { class: 'toggle' }, h('span', { class: 'small' }, 'krank'),
              h('input', { type: 'checkbox', class: 'switch', checked: item.checked, disabled,
                onchange: (event) => toggle(item.key, event.target.checked) }))),
          // A sick person's shift can be released for the Aushilfen page (without the name).
          ...(item.checked ? renderReleases(day, `krank:${item.key.split(':')[1]}`, item.key, BG.labelRanges(item.label), disabled) : []),
        ]),
        others,
        slotItem ? h('li', { class: 'row slot' },
          h('span', {}, slotItem.label.replace(/^Offene Aushilfe\s+/, 'Aushilfe ').replace(/:\s*(keine verfügbar|gefunden)$/, '')),
          zusagen.length
            ? h('span', { class: 'zusagen' }, zusagen.map((zusage) => h('span', { class: 'zusage' },
              `✓ ${zusage.name} ${zusage.from}–${zusage.to}`,
              h('button', { type: 'button', class: 'remove', disabled, title: 'Zusage zurücknehmen',
                'aria-label': `Zusage von ${zusage.name} zurücknehmen`, onclick: () => removeZusage(zusage, day) }, '✕'))))
            : h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': `Aushilfe ${DAYS[day - 1]}` },
              [['offen', 'gesucht'], ['gefunden', 'gefunden'], ['keine', 'keine']].map(([value, label]) =>
                h('button', { type: 'button', class: slotValue === value ? 'active' : '', role: 'radio',
                  'aria-checked': String(slotValue === value), disabled: disabled || slotValue === value,
                  onclick: () => setSlot(day, value) }, label)))) : null,
        slotItem ? renderReleases(day, 'aushilfe', slotKeys.gefunden, BG.labelRanges(slotItem.label), disabled) : null,
        !sickItems.length && !slotItem && !others.length ? h('li', { class: 'row muted' }, 'Keine Schichten') : null),
      renderChildren(childLists ? childLists.lists[String(day)] : null, childLists ? childLists.zeitpunkt : ''));
  }

  /**
   * The release rows of one shift for the Aushilfen page: each released slot (switch = visible
   * there, the Zusage it got, "Entfernen") and "+ Für Aushilfen freigeben" with a proposal.
   */
  function renderReleases(day, source, afterKey, ranges, disabled) {
    const releases = state.items
      .map((item) => ({ item, release: BG.parseReleaseKey(item.key) }))
      .filter(({ release }) => release && release.day === day && release.source === source);
    const rows = releases.map(({ item, release }) => {
      const zusagen = BG.slotSubstitutes(state.comments, day, `${release.start}–${release.end}`);
      let taken = h('span', { class: 'muted small' }, item.checked ? 'offen' : 'nicht sichtbar');
      if (zusagen.length && source === 'aushilfe') {
        // The ✕ for these Zusagen is on the open Aushilfe row above.
        taken = h('span', { class: 'zusage' }, zusagen.map((zusage) => `✓ ${zusage.name}`).join(', '));
      } else if (zusagen.length) {
        taken = h('span', { class: 'zusagen' }, zusagen.map((zusage) => h('span', { class: 'zusage' },
          `✓ ${zusage.name} ${zusage.from}–${zusage.to}`,
          h('button', { type: 'button', class: 'remove', disabled, title: 'Zusage zurücknehmen',
            'aria-label': `Zusage von ${zusage.name} zurücknehmen`, onclick: () => removeZusage(zusage, day) }, '✕'))));
      }
      return h('li', { class: 'row release' },
        h('label', { class: 'toggle' },
          h('input', { type: 'checkbox', class: 'switch', checked: item.checked, disabled,
            title: 'Auf der Aushilfen-Seite sichtbar', onchange: (event) => toggle(item.key, event.target.checked) }),
          h('span', {}, `Für Aushilfen ${release.start}–${release.end}`)),
        taken,
        h('button', { type: 'button', class: 'remove', disabled, title: 'Freigabe entfernen',
          onclick: () => deleteRelease(item.key) }, 'Entfernen'));
    });
    const proposal = BG.proposeRelease(ranges, releases.map(({ release }) => release));
    if (state.releaseForm === afterKey && ranges.length) {
      const times = BG.timeOptions('08:30', '18:00', 15);
      const start = proposal ? proposal.start : ranges[0].start;
      const end = proposal ? proposal.end : ranges[0].end;
      rows.push(h('li', { class: 'row release' },
        h('form', { class: 'release-form', onsubmit: (event) => {
          event.preventDefault();
          addRelease(afterKey, source, day, ranges, event.target.elements.von.value, event.target.elements.bis.value);
        } },
        h('label', {}, 'von', h('select', { name: 'von' }, times.map((time) => h('option', { value: time, selected: time === start }, time)))),
        h('label', {}, 'bis', h('select', { name: 'bis' }, times.map((time) => h('option', { value: time, selected: time === end }, time)))),
        h('button', { type: 'submit', class: 'secondary', disabled }, 'Freigeben'),
        h('button', { type: 'button', class: 'remove', onclick: () => { state.releaseForm = null; render(); } }, 'Abbrechen'))));
    } else if (proposal) {
      rows.push(h('li', { class: 'row release' },
        h('button', { type: 'button', class: 'link-button', disabled, onclick: () => { state.releaseForm = afterKey; render(); } },
          '+ Für Aushilfen freigeben')));
    }
    return rows;
  }

  /** The children of a day (first names, * = Eingewöhnung, "bis HH:MM" = early pick-up), collapsed. */
  function renderChildren(list, zeitpunkt) {
    if (!list || (!list.anwesend.length && !list.abwesend.length)) return null;
    const counted = list.anwesend.filter((name) => !name.includes('*')).length;
    const when = new Date(zeitpunkt);
    const stand = isNaN(when) ? '' : ` · Stand ${when.toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`;
    const summary = `👶 ${counted} Kinder${list.abwesend.length ? ` · ${list.abwesend.length} fehlen` : ''}${stand}`;
    return h('details', { class: 'children' },
      h('summary', {}, summary),
      h('ul', { class: 'name-chips' }, list.anwesend.map((name) => h('li', { class: name.includes('*') ? 'eingewoehnung' : '' }, name))),
      list.abwesend.length
        ? [h('p', { class: 'muted small absent-title' }, 'Fehlen (krank/Urlaub):'),
          h('ul', { class: 'name-chips absent' }, list.abwesend.map((name) => h('li', {}, name)))]
        : null,
      list.anwesend.some((name) => name.includes('*')) || list.abwesend.some((name) => name.includes('*'))
        ? h('p', { class: 'muted small' }, '* in Eingewöhnung, zählt nicht mit')
        : null);
  }

  function renderSubstituteForm() {
    const disabled = state.busy || Boolean(state.waiting);
    const datalist = h('datalist', { id: 'known-names' }, knownNames().map((name) => h('option', { value: name })));
    return h('section', { class: 'card' },
      h('h2', {}, 'Aushilfe mit Namen eintragen'),
      h('p', { class: 'muted small' }, 'Für eine Aushilfe zu eigenen Zeiten. Wird beim nächsten „Neu berechnen“ verschickt.'),
      h('form', { class: 'substitute', onsubmit: (event) => { event.preventDefault(); submitSubstitute(event.target); } },
        datalist,
        h('label', {}, 'Vorname', h('input', { name: 'name', type: 'text', list: 'known-names', autocomplete: 'off', required: true })),
        dayAndTimeFields('08:00', '16:00'),
        h('button', { type: 'submit', class: 'secondary wide', disabled }, 'Eintragen')));
  }

  /** Days (Mo–Fr) and von/bis selects, shared by the substitute and the Elterndienst form. */
  function dayAndTimeFields(defaultFrom, defaultTo) {
    const times = BG.timeOptions('07:00', '18:00', 15);
    return [
      h('fieldset', { class: 'days' }, h('legend', {}, 'Tage'),
        SHORT_DAYS.map((short, index) => h('label', { class: 'chip' },
          h('input', { type: 'checkbox', name: 'tag', value: String(index + 1) }), short))),
      h('div', { class: 'field-row' },
        h('label', {}, 'von', h('select', { name: 'von' }, times.map((time) => h('option', { value: time, selected: time === defaultFrom }, time)))),
        h('label', {}, 'bis', h('select', { name: 'bis' }, times.map((time) => h('option', { value: time, selected: time === defaultTo }, time))))),
    ];
  }

  function renderParentDutyForm() {
    const disabled = state.busy || Boolean(state.waiting);
    return h('section', { class: 'card' },
      h('h2', {}, 'Elterndienst eintragen'),
      h('p', { class: 'muted small' },
        'Hilft nur, wenn eine Kernteam-Kraft allein ist (8 → 10 Kinder). Sonst wird er trotzdem eingetragen, '
        + 'und die Antwort sagt „bringt keine Verbesserung“.'),
      h('form', { class: 'substitute', onsubmit: (event) => { event.preventDefault(); submitParentDuty(event.target); } },
        dayAndTimeFields('08:00', '12:30'),
        h('button', { type: 'submit', class: 'secondary wide', disabled }, 'Eintragen')));
  }

  function renderLastRun(view) {
    if (!view) {
      return h('section', { class: 'card' }, h('h2', {}, 'Letzter Lauf'),
        h('p', { class: 'muted' }, 'Noch keine Auswertung mit Zusammenfassung. Nach dem nächsten „Neu berechnen“ steht sie hier.'));
    }
    const when = new Date(view.zeitpunkt);
    const modes = { full: 'Wochenmeldung', recalculate: 'Neu berechnet', preview: 'Vorschau', reset: 'Zurückgesetzt' };
    const preview = view.modus === 'preview';
    return h('section', { class: 'card' },
      h('h2', {}, 'Letzter Lauf'),
      h('p', { class: 'small' }, `${modes[view.modus] || view.modus} · ${isNaN(when) ? view.zeitpunkt : when.toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })} · `,
        view.versendet ? h('b', {}, 'verschickt') : h('span', { class: 'muted' }, 'nichts verschickt'),
        view.ab_heute ? ' · ab heute' : ''),
      view.fehler && view.fehler.length ? h('ul', { class: 'problems' }, view.fehler.map((text) => h('li', {}, `❌ ${text}`))) : null,
      view.hinweise && view.hinweise.length ? h('ul', { class: 'hints' }, view.hinweise.map((text) => h('li', {}, text))) : null,
      preview
        ? h('p', { class: 'small' }, view.nachrichten && view.nachrichten.length
          ? 'Diese Nachrichten würden mit „Neu berechnen und senden“ verschickt:'
          : 'Mit „Neu berechnen und senden“ würde nichts verschickt.')
        : null,
      (view.nachrichten || []).map((message) => h('details', { class: 'message' },
        h('summary', {}, message.titel), h('pre', {}, message.text))),
      view.aenderungen && view.aenderungen.length
        ? h('details', { class: 'message' }, h('summary', {}, `Aktive Änderungen (${view.aenderungen.length})`),
          h('ul', {}, view.aenderungen.map((text) => h('li', {}, text))))
        : null);
  }

  function formatDate(date) {
    return `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.`;
  }

  // ---------- Dialogs ----------

  function openSettings() {
    $('#token-input').value = state.token;
    $('#repo-input').value = state.repo;
    $('#settings-dialog').showModal();
  }

  function openWeekDialog() {
    const now = BG.isoWeek(new Date());
    const next = BG.isoWeek(new Date(Date.now() + 7 * 86400000));
    const previous = BG.isoWeek(new Date(Date.now() - 7 * 86400000));
    $('#week-year').value = next.year;
    $('#week-number').value = next.week;
    $('#quick-weeks').replaceChildren(...[['Letzte', previous], ['Diese', now], ['Nächste', next]].map(([label, week]) =>
      h('button', { type: 'button', class: 'small-button', onclick: () => {
        $('#week-year').value = week.year;
        $('#week-number').value = week.week;
      } }, `${label} (KW${week.week})`)));
    $('#week-dialog').showModal();
  }

  function setUp() {
    $('#refresh').addEventListener('click', () => { state.info = ''; reload(); });
    $('#open-settings').addEventListener('click', openSettings);
    $('#cancel-settings').addEventListener('click', () => $('#settings-dialog').close());
    $('#forget-token').addEventListener('click', () => {
      store.remove('bg_token');
      state.token = '';
      $('#token-input').value = '';
      state.issues = [];
      state.issue = null;
      $('#settings-dialog').close();
      render();
    });
    $('#settings-form').addEventListener('submit', () => {
      state.token = $('#token-input').value.trim();
      state.repo = $('#repo-input').value.trim() || DEFAULT_REPO;
      store.set('bg_token', state.token);
      store.set('bg_repo', state.repo);
      reload();
    });
    $('#week-select').addEventListener('change', (event) => {
      state.number = Number(event.target.value);
      state.info = '';
      reload({ issues: false });
    });
    $('#new-week').addEventListener('click', openWeekDialog);
    $('#cancel-week').addEventListener('click', () => $('#week-dialog').close());
    $('#week-form').addEventListener('submit', () => {
      const year = Number($('#week-year').value);
      const week = Number($('#week-number').value);
      if (week < 1 || week > BG.weeksInYear(year)) {
        state.error = `Die KW${week} gibt es im Jahr ${year} nicht.`;
        render();
        return;
      }
      createWeek(year, week);
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* works without, just not offline */ });
    }
    reload();
  }

  setUp();
})();
