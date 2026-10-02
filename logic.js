// Pure functions of the app (no DOM, no network), shared by app.js and the Node tests in test/.
// They mirror dienstplan/week_issue.py in the main repository: the checklist in the week issue's
// description, the hidden markers in the workflow's replies, and the comment format for a substitute.
(function (root) {
  'use strict';

  const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
  const SHORT_DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
  const KEYS = { recalc: 'neu-berechnen', reset: 'zuruecksetzen', fromToday: 'ab-heute', children: 'kinder-aktualisieren' };
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
   * What has been changed since the last send: checkmarks and comments not yet handled.
   * @param {Array<object>} items From parseChecklist().
   * @param {Array<object>} comments All issue comments, oldest first.
   * @returns {{added: Array<object>, removed: Array<object>, comments: Array<object>}} Checklist
   *   items newly checked / unchecked, and comments by people written since the stored state.
   */
  function pendingChanges(items, comments) {
    const marker = latestMarker(comments, 'wochenstand');
    const handled = new Set(marker ? marker.data.haken || [] : []);
    const changeItems = items.filter((item) => !SETTING_KEYS.has(item.key));
    const seen = marker
      ? Number(marker.data.kommentar) || 0
      : Math.max(0, ...comments.filter(isBot).map((comment) => comment.id));
    return {
      added: changeItems.filter((item) => item.checked && !handled.has(item.key)),
      removed: changeItems.filter((item) => !item.checked && handled.has(item.key)),
      comments: comments.filter((comment) => !isBot(comment) && comment.id > seen),
    };
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
   * @returns {Array<{name: string, from: string, to: string}>}
   */
  function slotSubstitutes(comments, day, slotLabel) {
    const slots = [...(slotLabel || '').matchAll(/(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})/g)]
      .map((match) => [minutesOf(match[1]), minutesOf(match[2])]);
    let resetUpTo = 0;
    for (const comment of comments) {
      const match = isBot(comment) && (comment.body || '').match(/<!-- wochenstand (\{.*?\}) -->/s);
      if (!match) continue;
      try {
        const data = JSON.parse(match[1]);
        if (data.zurueckgesetzt) resetUpTo = Math.max(resetUpTo, Number(data.kommentar) || 0);
      } catch (error) {
        // A broken marker counts as none.
      }
    }
    const found = [];
    for (const comment of comments) {
      if (isBot(comment) || comment.id <= resetUpTo) continue;
      for (const match of (comment.body || '').matchAll(SUBSTITUTE_RE)) {
        const days = [...match[2].matchAll(new RegExp(DAY_WORD, 'gi'))]
          .map((word) => DAYS.findIndex((name) => name.toLowerCase() === word[0].toLowerCase()) + 1);
        const [from, to] = [minutesOf(match[3]), minutesOf(match[4])];
        if (days.includes(day) && slots.some(([start, end]) => from < end && to > start)) {
          const pad = (time) => time.padStart(5, '0');
          found.push({ name: match[1], from: pad(match[3]), to: pad(match[4]) });
        }
      }
    }
    return found;
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

  const api = {
    DAYS,
    SHORT_DAYS,
    KEYS,
    SETTING_KEYS,
    parseChecklist,
    setChecks,
    latestMarker,
    latestChildren,
    isBot,
    pendingChanges,
    isoWeek,
    dateOf,
    weeksInYear,
    weekTitle,
    parseWeekTitle,
    joinGerman,
    substituteComment,
    parentDutyComment,
    slotSubstitutes,
    timeOptions,
    splitDayLine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BG = api;
})(this);
