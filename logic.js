// Pure functions of the app (no DOM, no network), shared by app.js and the Node tests in test/.
// They mirror dienstplan/week_issue.py in the main repository: the checklist in the week issue's
// description, the hidden markers in the workflow's replies, and the comment format for a substitute.
(function (root) {
  'use strict';

  const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
  const SHORT_DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
  const KEYS = { recalc: 'neu-berechnen', preview: 'nur-berechnen', reset: 'zuruecksetzen', fromToday: 'ab-heute', fromTomorrow: 'ab-morgen', children: 'kinder-aktualisieren', refresh: 'aus-famly' };
  // Added by the workflow's "Aus Famly aktualisieren" to a line it keeps although its shift is gone
  // (GONE_MARK in week_issue.py).
  const GONE_MARK = ' (nicht mehr in Famly)';
  const SETTING_KEYS = new Set(Object.values(KEYS));
  // "- [ ] <text> <!-- key -->", like CHECKBOX in week_issue.py.
  const LINE_RE = /^(\s*[-*] \[)([ xX])(\] )(.*?)\s*<!-- (\S+) -->\s*$/;

  /**
   * Reads the checklist of a week issue's description.
   * @param {string} body The issue description.
   * @returns {Array<{key: string, checked: boolean, label: string, day: number}>} One entry per
   *   checkbox line; `day` is 1 (Mon) … 5 (Fri), or 0 for the "Woche" section.
   */
  function parseChecklist(body) {
    const items = [];
    let day = 0;
    for (const line of (body || '').split(/\r?\n/)) {
      const heading = line.match(/^###\s+([A-Za-zÄÖÜäöüß]+)/);
      if (heading) {
        day = DAYS.indexOf(heading[1]) + 1;
        continue;
      }
      const match = line.match(LINE_RE);
      if (match) {
        items.push({ key: match[5], checked: match[2] !== ' ', label: match[4].trim(), day });
      }
    }
    return items;
  }

  /**
   * Sets checkmarks in a description, leaving everything else untouched.
   * @param {string} body The current issue description.
   * @param {Object<string, boolean>} changes Key -> checked.
   * @returns {string} The new description.
   * @throws {Error} A key has no checklist line.
   */
  function setChecks(body, changes) {
    const newline = body.includes('\r\n') ? '\r\n' : '\n';
    const missing = new Set(Object.keys(changes));
    const lines = body.split(/\r?\n/).map((line) => {
      const match = line.match(LINE_RE);
      if (!match || !(match[5] in changes)) return line;
      missing.delete(match[5]);
      // match[1] is everything up to "["; the next character is the mark.
      return match[1] + (changes[match[5]] ? 'x' : ' ') + line.slice(match[1].length + 1);
    });
    if (missing.size) throw new Error(`Zeile nicht gefunden: ${[...missing].join(', ')}`);
    return lines.join(newline);
  }

  /**
   * A checklist label without the "nicht mehr in Famly" mark, and whether it had it.
   * @param {string} label From parseChecklist(), e.g. "Anna 08:00–14:00 (nicht mehr in Famly) krank".
   * @returns {{text: string, gone: boolean}}
   */
  function goneLabel(label) {
    const gone = (label || '').includes(GONE_MARK);
    return { text: gone ? label.replace(GONE_MARK, '') : label || '', gone };
  }

  /**
   * Where the messages start, by the "Versenden ab …" settings; "ab morgen" wins, as in Python.
   * @param {Array<object>} items From parseChecklist().
   * @returns {string} "woche", "heute" or "morgen".
   */
  function sendFrom(items) {
    const checked = (key) => items.some((item) => item.key === key && item.checked);
    if (checked(KEYS.fromTomorrow)) return 'morgen';
    return checked(KEYS.fromToday) ? 'heute' : 'woche';
  }

  /**
   * The checkbox changes for setChecks() that select one "Versenden ab …" value; only lines the
   * checklist has are touched.
   * @param {string} value "woche", "heute" or "morgen".
   * @param {Array<object>} items From parseChecklist().
   * @returns {Object<string, boolean>}
   */
  function sendFromChecks(value, items) {
    const wanted = { [KEYS.fromToday]: value === 'heute', [KEYS.fromTomorrow]: value === 'morgen' };
    return Object.fromEntries(Object.entries(wanted).filter(([key]) => items.some((item) => item.key === key)));
  }

  /**
   * The JSON of a hidden marker in the newest reply of the workflow that has one.
   * @param {Array<object>} comments Issue comments as delivered by the GitHub API, oldest first.
   * @param {string} name "wochenstand" or "wochenansicht".
   * @returns {{data: object, comment: object}|null}
   */
  function latestMarker(comments, name) {
    const re = new RegExp(`<!-- ${name} (\\{.*?\\}) -->`, 's');
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      const comment = comments[i];
      if (!isBot(comment)) continue;
      const match = (comment.body || '').match(re);
      if (!match) continue;
      try {
        return { data: JSON.parse(match[1]), comment };
      } catch (error) {
        // A broken marker counts as none, like WeekState parsing in Python.
      }
    }
    return null;
  }

  /**
   * The newest children per day: from a "Kinderbelegung aktualisieren" reply (`wochenkinder`) or
   * from the summary of a normal run (`wochenansicht`), whichever is newer.
   * @param {Array<object>} comments Issue comments, oldest first.
   * @returns {{lists: Object<string, {anwesend: string[], abwesend: string[]}>, zeitpunkt: string}|null}
   */
  function latestChildren(comments) {
    for (let i = comments.length - 1; i >= 0; i -= 1) {
      for (const name of ['wochenkinder', 'wochenansicht']) {
        const marker = latestMarker([comments[i]], name);
        if (marker && marker.data.kinderliste && Object.keys(marker.data.kinderliste).length) {
          return { lists: marker.data.kinderliste, zeitpunkt: marker.data.zeitpunkt };
        }
      }
    }
    return null;
  }

  function isBot(comment) {
    return Boolean(comment && comment.user && comment.user.type === 'Bot');
  }

  /**
   * What has been changed since the last send: checkmarks, comments and Zusagen not yet handled.
   * @param {Array<object>} items From parseChecklist().
   * @param {Array<object>} comments All issue comments, oldest first.
   * @param {{year: number, week: number}|null} [week] The issue's week, for a Zusage without "am".
   * @returns {{added: Array<object>, removed: Array<object>, comments: Array<object>,
   *   withdrawn: Array<{name: string, day: number}>, changed: Array<string>,
   *   withdrawnDuties: Array<{day: number, from: string, to: string}>, changedDuties: Array<string>}}
   *   Checklist items newly checked / unchecked, comments by people written since the stored state,
   *   Zusagen sent before and gone now (like withdrawn_substitutes() in Python), and Zusagen
   *   ("Name:Tag:HH:MM-HH:MM") from older comments that were changed since. The last two only if the
   *   state stores `zusagen` (states before that don't). The same for Elterndienste
   *   (withdrawn_parent_duties(), "Tag:HH:MM-HH:MM"), only if the state stores `elterndienste`.
   */
  function pendingChanges(items, comments, week = null) {
    const marker = latestMarker(comments, 'wochenstand');
    const handled = new Set(marker ? marker.data.haken || [] : []);
    // Release lines for the Aushilfen page are no change of the week, like the toggles.
    const changeItems = items.filter((item) => !SETTING_KEYS.has(item.key) && !item.key.startsWith('freigabe:'));
    const seen = marker
      ? Number(marker.data.kommentar) || 0
      : Math.max(0, ...comments.filter(isBot).map((comment) => comment.id));
    const pending = {
      added: changeItems.filter((item) => item.checked && !handled.has(item.key)),
      removed: changeItems.filter((item) => !item.checked && handled.has(item.key)),
      comments: comments.filter((comment) => !isBot(comment) && comment.id > seen),
      withdrawn: [],
      changed: [],
      withdrawnDuties: [],
      changedDuties: [],
    };
    if (marker && Array.isArray(marker.data.zusagen)) {
      const sent = new Set(marker.data.zusagen);
      const current = substituteEntries(comments, week);
      const stillThere = new Set([...current.keys()].map((entry) => nameAndDay(entry).join(':').toLowerCase()));
      const withdrawn = new Map();
      for (const entry of sent) {
        const [name, day] = nameAndDay(entry);
        if (!stillThere.has(`${name}:${day}`.toLowerCase())) withdrawn.set(`${name}:${day}`, { name, day });
      }
      pending.withdrawn = [...withdrawn.values()].sort((a, b) => a.day - b.day || a.name.localeCompare(b.name));
      pending.changed = [...current].filter(([entry, id]) => !sent.has(entry) && id <= seen).map(([entry]) => entry).sort();
    }
    if (marker && Array.isArray(marker.data.elterndienste)) {
      const sent = new Set(marker.data.elterndienste);
      const current = parentDutyEntries(comments, week);
      // A day with a new Elterndienst (e.g. changed times) has no withdrawn one, as in Python.
      const daysWithNew = new Set([...current.keys()].filter((entry) => !sent.has(entry)).map((entry) => Number(entry.split(':')[0])));
      pending.withdrawnDuties = [...sent]
        .filter((entry) => !current.has(entry) && !daysWithNew.has(Number(entry.split(':')[0])))
        .map((entry) => {
          const [day, ...times] = entry.split(':');
          const [from, to] = times.join(':').split('-');
          return { day: Number(day), from, to };
        })
        .sort((a, b) => a.day - b.day || a.from.localeCompare(b.from));
      pending.changedDuties = [...current].filter(([entry, id]) => !sent.has(entry) && id <= seen).map(([entry]) => entry).sort();
    }
    return pending;
  }

  function nameAndDay(entry) {
    const [name, day] = entry.split(':');
    return [name, Number(day)];
  }

  /** The id up to which "Alles zurücksetzen" dropped the comments (from the wochenstand markers). */
  function resetUpTo(comments) {
    let upTo = 0;
    for (const comment of comments) {
      const match = isBot(comment) && (comment.body || '').match(/<!-- wochenstand (\{.*?\}) -->/s);
      if (!match) continue;
      try {
        const data = JSON.parse(match[1]);
        if (data.zurueckgesetzt) upTo = Math.max(upTo, Number(data.kommentar) || 0);
      } catch (error) {
        // A broken marker counts as none.
      }
    }
    return upTo;
  }

  /** The weekday 1-5 of the week on which a comment was written (Berlin time), or 0. */
  function writtenDay(comment, week) {
    if (!week || !comment.created_at) return 0;
    const written = new Date(comment.created_at).toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
    for (let day = 1; day <= 5; day += 1) {
      if (dateOf(week.year, week.week, day).toISOString().slice(0, 10) === written) return day;
    }
    return 0;
  }

  /**
   * The Zusagen in the comments since the last reset, like substitute_entries() in Python.
   * @param {Array<object>} comments All issue comments, oldest first.
   * @param {{year: number, week: number}|null} week The issue's week, for a Zusage without "am".
   * @returns {Map<string, number>} "Name:Tag:HH:MM-HH:MM" (name capitalized) -> id of the comment.
   */
  function substituteEntries(comments, week) {
    const upTo = resetUpTo(comments);
    const entries = new Map();
    for (const comment of comments) {
      if (isBot(comment) || comment.id <= upTo) continue;
      for (const match of (comment.body || '').matchAll(ANY_SUBSTITUTE_RE)) {
        const days = match[2]
          ? [...match[2].matchAll(new RegExp(DAY_WORD, 'gi'))]
            .map((word) => DAYS.findIndex((name) => name.toLowerCase() === word[0].toLowerCase()) + 1)
          : [writtenDay(comment, week)].filter(Boolean);
        const name = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
        const pad = (time) => time.padStart(5, '0');
        for (const day of days) entries.set(`${name}:${day}:${pad(match[3])}-${pad(match[4])}`, comment.id);
      }
    }
    return entries;
  }

  /**
   * The added Elterndienste in the comments since the last reset, like parent_duty_entries() in Python.
   * @param {Array<object>} comments All issue comments, oldest first.
   * @param {{year: number, week: number}|null} week The issue's week, for an Elterndienst without "am".
   * @returns {Map<string, number>} "Tag:HH:MM-HH:MM" -> id of the comment.
   */
  function parentDutyEntries(comments, week) {
    const upTo = resetUpTo(comments);
    const entries = new Map();
    for (const comment of comments) {
      if (isBot(comment) || comment.id <= upTo) continue;
      for (const match of (comment.body || '').matchAll(ANY_PARENT_DUTY_RE)) {
        const days = match[1] ? daysOf(match[1]) : [writtenDay(comment, week)].filter(Boolean);
        const pad = (time) => time.padStart(5, '0');
        for (const day of days) entries.set(`${day}:${pad(match[2])}-${pad(match[3])}`, comment.id);
      }
    }
    return entries;
  }

  /**
   * The ISO week of a date.
   * @param {Date} date
   * @returns {{year: number, week: number}}
   */
  function isoWeek(date) {
    const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const weekday = day.getUTCDay() || 7;
    day.setUTCDate(day.getUTCDate() + 4 - weekday);
    const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
    return { year: day.getUTCFullYear(), week: Math.ceil(((day - yearStart) / 86400000 + 1) / 7) };
  }

  /** The date (UTC midnight) of a weekday (1=Mon…7=Sun) in an ISO week. */
  function dateOf(year, week, day) {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const monday = new Date(jan4);
    monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() || 7) - 1) + (week - 1) * 7);
    monday.setUTCDate(monday.getUTCDate() + day - 1);
    return monday;
  }

  /** Number of ISO weeks of a year (52 or 53). */
  function weeksInYear(year) {
    return isoWeek(new Date(year, 11, 28)).week;
  }

  /** "2026 KW05", like week_title() in Python. */
  function weekTitle(year, week) {
    return `${year} KW${String(week).padStart(2, '0')}`;
  }

  /**
   * Reads year and week from a week issue title ("2026 KW42", "KW42", "Woche KW42").
   * @returns {{year: number, week: number}|null}
   */
  function parseWeekTitle(title, fallbackYear) {
    const match = (title || '').match(/(?:(\d{4})\s+)?(?:Woche\s+)?KW\s*(\d{1,2})\b/i);
    if (!match) return null;
    return { year: match[1] ? Number(match[1]) : fallbackYear, week: Number(match[2]) };
  }

  /** "A", "A und B", "A, B und C". */
  function joinGerman(parts) {
    if (parts.length <= 1) return parts.join('');
    return `${parts.slice(0, -1).join(', ')} und ${parts[parts.length - 1]}`;
  }

  /**
   * The comment for a found substitute, in the format the week issue parses
   * ("<Name> springt ein am <Tage> HH:MM-HH:MM").
   * @param {string} name First name of the substitute.
   * @param {Array<number>} days Weekdays 1-5.
   * @param {string} from "HH:MM".
   * @param {string} to "HH:MM".
   * @returns {string}
   * @throws {Error} Invalid input (message in German, shown in the app).
   */
  function substituteComment(name, days, from, to) {
    const cleaned = (name || '').trim();
    if (!/^[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß-]*$/.test(cleaned)) {
      throw new Error('Bitte nur einen Vornamen (Buchstaben) eingeben.');
    }
    if (cleaned.toLowerCase() === 'aushilfe') throw new Error('Bitte den echten Namen der Aushilfe eingeben.');
    if (!days.length) throw new Error('Bitte mindestens einen Tag wählen.');
    if (!(from < to)) throw new Error('„von“ muss vor „bis“ liegen.');
    const sortedDays = [...new Set(days)].sort((a, b) => a - b).map((day) => DAYS[day - 1]);
    const display = cleaned[0].toUpperCase() + cleaned.slice(1);
    return `${display} springt ein am ${joinGerman(sortedDays)} ${from}-${to}`;
  }

  /**
   * The comment for an added Elterndienst ("Elterndienst am <Tage> HH:MM-HH:MM"), as the week issue
   * parses it. By the rules it only helps one kernteam person alone; otherwise the workflow adds a hint.
   * @param {Array<number>} days Weekdays 1-5.
   * @param {string} from "HH:MM".
   * @param {string} to "HH:MM".
   * @returns {string}
   * @throws {Error} Invalid input (message in German, shown in the app).
   */
  function parentDutyComment(days, from, to) {
    if (!days.length) throw new Error('Bitte mindestens einen Tag wählen.');
    if (!(from < to)) throw new Error('„von“ muss vor „bis“ liegen.');
    const sortedDays = [...new Set(days)].sort((a, b) => a - b).map((day) => DAYS[day - 1]);
    return `Elterndienst am ${joinGerman(sortedDays)} ${from}-${to}`;
  }

  const DAY_WORD = '(?:montag|dienstag|mittwoch|donnerstag|freitag)';
  // "<Name> springt ein am <Tage> HH:MM-HH:MM", as written by the app and the Aushilfen page.
  const SUBSTITUTE_RE = new RegExp(
    `([^\\s\\d,][^\\s,]*)\\s+springt\\s+ein\\s+am\\s+(${DAY_WORD}(?:\\s*,\\s*${DAY_WORD}|\\s+und\\s+${DAY_WORD})*)\\s+(\\d{1,2}:\\d{2})\\s*-\\s*(\\d{1,2}:\\d{2})`,
    'gi',
  );

  // The same, with "am <Tage>" optional (then it is the day the comment was written), like SUBSTITUTE
  // in week_issue.py.
  const ANY_SUBSTITUTE_RE = new RegExp(
    `([^\\s\\d,][^\\s,]*)\\s+springt\\s+ein(?:\\s+am\\s+(${DAY_WORD}(?:\\s*,\\s*${DAY_WORD}|\\s+und\\s+${DAY_WORD})*))?\\s+(\\d{1,2}:\\d{2})\\s*-\\s*(\\d{1,2}:\\d{2})`,
    'gi',
  );

  // "Elterndienst am <Tage> HH:MM-HH:MM", as written by the app.
  const PARENT_DUTY_RE = new RegExp(
    `Elterndienst\\s+am\\s+(${DAY_WORD}(?:\\s*,\\s*${DAY_WORD}|\\s+und\\s+${DAY_WORD})*)\\s+(\\d{1,2}:\\d{2})\\s*-\\s*(\\d{1,2}:\\d{2})`,
    'gi',
  );

  // The same, with "am <Tage>" optional, like PARENT_DUTY in week_issue.py.
  const ANY_PARENT_DUTY_RE = new RegExp(
    `Elterndienst(?:\\s+am\\s+(${DAY_WORD}(?:\\s*,\\s*${DAY_WORD}|\\s+und\\s+${DAY_WORD})*))?\\s+(\\d{1,2}:\\d{2})\\s*-\\s*(\\d{1,2}:\\d{2})`,
    'gi',
  );

  /** Weekdays 1-5 of a day list like "Montag, Mittwoch und Freitag". */
  function daysOf(text) {
    return [...text.matchAll(new RegExp(DAY_WORD, 'gi'))]
      .map((word) => DAYS.findIndex((name) => name.toLowerCase() === word[0].toLowerCase()) + 1);
  }

  function minutesOf(time) {
    const [hours, mins] = time.split(':').map(Number);
    return hours * 60 + mins;
  }

  /**
   * Substitutes from comments since the last "Alles zurücksetzen" whose time overlaps the day's
   * open Aushilfe slot, e.g. a Zusage from the Aushilfen page. Such a slot is taken, although
   * neither of its checkboxes is checked.
   * @param {Array<object>} comments All issue comments, oldest first.
   * @param {number} day Weekday 1-5.
   * @param {string} slotLabel The checklist label, e.g. "Offene Aushilfe 12:00–16:00: gefunden".
   * @returns {Array<{name: string, from: string, to: string, commentId: number, index: number}>}
   *   `commentId` and `index` (position of the match in the comment) for withoutSubstituteDay().
   */
  function slotSubstitutes(comments, day, slotLabel) {
    const slots = [...(slotLabel || '').matchAll(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/g)]
      .map((match) => [minutesOf(match[1]), minutesOf(match[2])]);
    const upTo = resetUpTo(comments);
    const found = [];
    for (const comment of comments) {
      if (isBot(comment) || comment.id <= upTo) continue;
      for (const match of (comment.body || '').matchAll(SUBSTITUTE_RE)) {
        const days = [...match[2].matchAll(new RegExp(DAY_WORD, 'gi'))]
          .map((word) => DAYS.findIndex((name) => name.toLowerCase() === word[0].toLowerCase()) + 1);
        const [from, to] = [minutesOf(match[3]), minutesOf(match[4])];
        if (days.includes(day) && slots.some(([start, end]) => from < end && to > start)) {
          const pad = (time) => time.padStart(5, '0');
          found.push({ name: match[1], from: pad(match[3]), to: pad(match[4]), commentId: comment.id, index: match.index });
        }
      }
    }
    return found;
  }

  /**
   * A comment without one day of a Zusage, to take it back: the other days and the rest of the
   * comment stay. An empty result means the comment can be deleted.
   * @param {string} body The comment as it is now.
   * @param {number} index Position of the Zusage in it (from slotSubstitutes()).
   * @param {number} day Weekday 1-5 to take out.
   * @returns {string} The new comment, '' if nothing is left.
   * @throws {Error} The comment no longer has that Zusage there (changed meanwhile).
   */
  function withoutSubstituteDay(body, index, day) {
    const match = [...(body || '').matchAll(SUBSTITUTE_RE)].find((candidate) => candidate.index === index);
    const days = match
      ? [...match[2].matchAll(new RegExp(DAY_WORD, 'gi'))]
        .map((word) => DAYS.findIndex((name) => name.toLowerCase() === word[0].toLowerCase()) + 1)
      : [];
    if (!days.includes(day)) throw new Error('Der Kommentar hat sich inzwischen geändert – bitte neu laden.');
    const rest = days.filter((other) => other !== day).map((other) => DAYS[other - 1]);
    const replacement = rest.length ? `${match[1]} springt ein am ${joinGerman(rest)} ${match[3]}-${match[4]}` : '';
    return (body.slice(0, index) + replacement + body.slice(index + match[0].length)).trim();
  }

  /**
   * The Elterndienste of one day from comments since the last "Alles zurücksetzen" (written with
   * "am <Tage>", as the app does), to show them with ✕.
   * @param {Array<object>} comments All issue comments, oldest first.
   * @param {number} day Weekday 1-5.
   * @returns {Array<{from: string, to: string, commentId: number, index: number}>}
   *   `commentId` and `index` (position of the match in the comment) for withoutParentDutyDay().
   */
  function dayParentDuties(comments, day) {
    const upTo = resetUpTo(comments);
    const found = [];
    for (const comment of comments) {
      if (isBot(comment) || comment.id <= upTo) continue;
      for (const match of (comment.body || '').matchAll(PARENT_DUTY_RE)) {
        if (daysOf(match[1]).includes(day)) {
          const pad = (time) => time.padStart(5, '0');
          found.push({ from: pad(match[2]), to: pad(match[3]), commentId: comment.id, index: match.index });
        }
      }
    }
    return found;
  }

  /**
   * A comment without one day of an Elterndienst, to take it back: the other days and the rest of
   * the comment stay. An empty result means the comment can be deleted.
   * @param {string} body The comment as it is now.
   * @param {number} index Position of the Elterndienst in it (from dayParentDuties()).
   * @param {number} day Weekday 1-5 to take out.
   * @returns {string} The new comment, '' if nothing is left.
   * @throws {Error} The comment no longer has that Elterndienst there (changed meanwhile).
   */
  function withoutParentDutyDay(body, index, day) {
    const match = [...(body || '').matchAll(PARENT_DUTY_RE)].find((candidate) => candidate.index === index);
    const days = match ? daysOf(match[1]) : [];
    if (!days.includes(day)) throw new Error('Der Kommentar hat sich inzwischen geändert – bitte neu laden.');
    const rest = days.filter((other) => other !== day).map((other) => DAYS[other - 1]);
    const replacement = rest.length ? `Elterndienst am ${joinGerman(rest)} ${match[2]}-${match[3]}` : '';
    return (body.slice(0, index) + replacement + body.slice(index + match[0].length)).trim();
  }

  /** Times "HH:MM" from `start` to `end` in steps of `step` minutes. */
  function timeOptions(start = '07:00', end = '18:00', step = 15) {
    const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    const options = [];
    for (let minute = toMinutes(start); minute <= toMinutes(end); minute += step) {
      options.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
    }
    return options;
  }

  /**
   * Splits an evaluated day line ("🟠 Mo 08:00 - 17:00 | ab 12:00: …") into status and text.
   * @returns {{status: string, text: string}} status: "gruen", "orange", "rot", "warnung" or "".
   */
  function splitDayLine(line) {
    const statuses = { '🟢': 'gruen', '🟠': 'orange', '🔴': 'rot', '⚠️': 'warnung' };
    for (const [emoji, status] of Object.entries(statuses)) {
      if ((line || '').startsWith(emoji)) {
        const text = line.slice(emoji.length).trim().replace(/^(Mo|Di|Mi|Do|Fr)\s+/, '');
        return { status, text };
      }
    }
    return { status: '', text: line || '' };
  }

  // ---------- Release for the Aushilfen page ----------
  // A release line in the checklist decides that the Aushilfen page shows a slot:
  // "- [x] Für Aushilfen freigegeben: Mi 08:30–14:30 <!-- freigabe:krank:Anna:3:08:30-14:30 -->".
  // The source is "aushilfe" (open Aushilfe shift from Famly) or "krank:<Name>" (a sick person's shift).
  // aushilfen/src/slots.js in the main repository reads the same keys.
  const RELEASE_PREFIX = 'freigabe:';
  const RELEASE_KEY_RE = /^freigabe:(aushilfe|krank:([^:]+)):([1-5]):(\d{2}:\d{2})-(\d{2}:\d{2})$/;
  // A slot for an Aushilfe starts at 08:30 at the earliest and lasts at most 6 hours.
  const RELEASE_EARLIEST = '08:30';
  const RELEASE_MAX_MINUTES = 6 * 60;

  function timeOf(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  /**
   * The key of a release line.
   * @param {string} source "aushilfe" or "krank:<Name>".
   * @param {number} day Weekday 1-5.
   * @param {string} start "HH:MM".
   * @param {string} end "HH:MM".
   * @returns {string}
   */
  function releaseKey(source, day, start, end) {
    return `${RELEASE_PREFIX}${source}:${day}:${start}-${end}`;
  }

  /**
   * Reads a release key.
   * @param {string} key
   * @returns {{source: string, day: number, start: string, end: string}|null} `source` as in
   *   releaseKey(); null for any other key.
   */
  function parseReleaseKey(key) {
    const match = (key || '').match(RELEASE_KEY_RE);
    return match ? { source: match[1], day: Number(match[3]), start: match[4], end: match[5] } : null;
  }

  /** The whole checklist line for a release key. */
  function releaseLine(key, checked = true) {
    const release = parseReleaseKey(key);
    return `- [${checked ? 'x' : ' '}] Für Aushilfen freigegeben: ${SHORT_DAYS[release.day - 1]} ${release.start}–${release.end} <!-- ${key} -->`;
  }

  /**
   * Inserts a line after the checklist line with `afterKey` and the release lines that follow it.
   * @param {string} body The issue description.
   * @param {string} afterKey E.g. "krank:Anna:3" or "aushilfe-gefunden:3".
   * @param {string} line The new line.
   * @returns {string} The new description.
   * @throws {Error} There is no line with `afterKey`.
   */
  function addLineAfter(body, afterKey, line) {
    const newline = body.includes('\r\n') ? '\r\n' : '\n';
    const lines = body.split(/\r?\n/);
    const keyOf = (text) => { const match = (text || '').match(LINE_RE); return match ? match[5] : null; };
    let index = lines.findIndex((text) => keyOf(text) === afterKey);
    if (index < 0) throw new Error(`Zeile nicht gefunden: ${afterKey}`);
    while (index + 1 < lines.length && (keyOf(lines[index + 1]) || '').startsWith(RELEASE_PREFIX)) index += 1;
    lines.splice(index + 1, 0, line);
    return lines.join(newline);
  }

  /** The description without the checklist line with `key` (unchanged if there is none). */
  function removeLine(body, key) {
    const newline = body.includes('\r\n') ? '\r\n' : '\n';
    return body.split(/\r?\n/).filter((text) => { const match = text.match(LINE_RE); return !match || match[5] !== key; }).join(newline);
  }

  /** The times in a checklist label, e.g. "Anna 08:00–12:00, 14:00–17:00 krank" → two ranges. */
  function labelRanges(label) {
    return [...(label || '').matchAll(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/g)]
      .map((match) => ({ start: match[1].padStart(5, '0'), end: match[2].padStart(5, '0') }));
  }

  /**
   * A proposal for the next release of a shift: from 08:30 at the earliest (or where the releases
   * so far end), for at most 6 hours.
   * @param {Array<{start: string, end: string}>} ranges The shift's times (labelRanges()).
   * @param {Array<{start: string, end: string}>} released The releases of this shift so far.
   * @returns {{start: string, end: string}|null} null if everything is released already.
   */
  function proposeRelease(ranges, released) {
    for (const range of ranges) {
      let start = Math.max(minutesOf(range.start), minutesOf(RELEASE_EARLIEST));
      for (const entry of released) {
        if (minutesOf(entry.start) <= start && minutesOf(entry.end) > start) start = minutesOf(entry.end);
      }
      const end = Math.min(minutesOf(range.end), start + RELEASE_MAX_MINUTES);
      if (end > start) return { start: timeOf(start), end: timeOf(end) };
    }
    return null;
  }

  /**
   * Checks a release before it is written.
   * @param {Array<{start: string, end: string}>} ranges The shift's times.
   * @param {string} start "HH:MM".
   * @param {string} end "HH:MM".
   * @throws {Error} The slot is outside the shift, starts before 08:30 or lasts longer than 6
   *   hours (message in German, shown in the app).
   */
  function checkRelease(ranges, start, end) {
    const [from, to] = [minutesOf(start), minutesOf(end)];
    if (!(from < to)) throw new Error('„von“ muss vor „bis“ liegen.');
    if (from < minutesOf(RELEASE_EARLIEST)) throw new Error(`Ein Slot für Aushilfen beginnt frühestens um ${RELEASE_EARLIEST}.`);
    if (to - from > RELEASE_MAX_MINUTES) throw new Error('Ein Slot für Aushilfen dauert höchstens 6 Stunden.');
    if (!ranges.some((range) => minutesOf(range.start) <= from && to <= minutesOf(range.end))) {
      throw new Error('Der Slot muss innerhalb der Schicht liegen.');
    }
  }

  const api = {
    DAYS,
    SHORT_DAYS,
    KEYS,
    SETTING_KEYS,
    parseChecklist,
    setChecks,
    sendFrom,
    goneLabel,
    sendFromChecks,
    latestMarker,
    latestChildren,
    isBot,
    pendingChanges,
    substituteEntries,
    parentDutyEntries,
    isoWeek,
    dateOf,
    weeksInYear,
    weekTitle,
    parseWeekTitle,
    joinGerman,
    substituteComment,
    parentDutyComment,
    slotSubstitutes,
    withoutSubstituteDay,
    dayParentDuties,
    withoutParentDutyDay,
    timeOptions,
    splitDayLine,
    RELEASE_PREFIX,
    releaseKey,
    parseReleaseKey,
    releaseLine,
    addLineAfter,
    removeLine,
    labelRanges,
    proposeRelease,
    checkRelease,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BG = api;
})(this);
