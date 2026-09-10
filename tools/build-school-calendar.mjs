// Turns the school's published iCal feed into a small JSON file the app
// can read directly.
//
// The app is a static site, and the feed sends no access-control-allow-origin,
// so the browser cannot fetch it: any attempt is blocked before it starts.
// Rather than routing every visitor through somebody else's CORS proxy, a
// scheduled job fetches it here and commits the result next to the app, where
// it is same-origin, cached by the service worker and available offline.
//
// Only what this feed actually uses is implemented. Every recurrence in it is
// FREQ=DAILY, every DURATION is P1D, so there is no general RFC 5545 engine
// here and there should not be one until the feed needs it.

const FEED = 'https://www.psis104.com/apps/events/ical/?id=0';
const OUT = new URL('../school-calendar.json', import.meta.url);
const TZ = 'America/New_York';   // X-WR-TIMEZONE on the feed is US/Eastern

// Folded lines continue with a space or tab; join them before anything else.
function unfold(text){
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

// \\ \, \; \n are escaped in iCal text values.
function unescapeText(v){
  return v.replace(/\\([\\,;])/g, '$1')
          .replace(/\\[nN]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
}

function parseProps(line){
  const at = line.indexOf(':');
  if (at < 0) return null;
  const rawKey = line.slice(0, at);
  const value = line.slice(at + 1);
  const bits = rawKey.split(';');
  const params = {};
  bits.slice(1).forEach(p => {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  });
  return { key: bits[0].toUpperCase(), params, value };
}

function parseEvents(ics){
  const out = [];
  let cur = null;
  for (const line of unfold(ics).split('\n')){
    const t = line.trim();
    if (t === 'BEGIN:VEVENT'){ cur = {}; continue; }
    if (t === 'END:VEVENT'){ if (cur) out.push(cur); cur = null; continue; }
    if (!cur) continue;
    const p = parseProps(t);
    if (!p) continue;
    if (p.key === 'EXDATE'){ (cur.EXDATE ||= []).push(p); continue; }
    if (!(p.key in cur)) cur[p.key] = p;
  }
  return out;
}

// "20260420" or "20251224T100000" -> "2026-04-20". The feed's timed events
// carry TZID=US/Eastern, and a student cares which calendar day the thing
// falls on locally, so the date is taken as written rather than routed
// through UTC, where an evening event would slide into the next day.
function localDate(value){
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// UNTIL is an absolute UTC instant, and these land just before local midnight
// (…T045959Z is 23:59:59 the previous day in Eastern). Comparing its UTC date
// against local dates would add a day that is not in the recurrence.
function utcStampToLocalDate(value){
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return localDate(value);
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(at));
}

function addDays(date, n){
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

// Only FREQ=DAILY, which is all this feed uses. INTERVAL, COUNT and UNTIL are
// honoured; anything else returns the single start date rather than guessing.
function occurrences(startDate, rrule, exdates){
  if (!rrule) return [startDate];
  const parts = {};
  rrule.split(';').forEach(p => {
    const eq = p.indexOf('=');
    if (eq > 0) parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  });
  if ((parts.FREQ || '').toUpperCase() !== 'DAILY') return [startDate];

  const step = Math.max(1, parseInt(parts.INTERVAL || '1', 10) || 1);
  const count = parts.COUNT ? parseInt(parts.COUNT, 10) : null;
  const until = parts.UNTIL ? utcStampToLocalDate(parts.UNTIL) : null;

  const dates = [];
  let cursor = startDate;
  // hard stop so a malformed rule cannot spin
  for (let i = 0; i < 400; i++){
    if (count !== null && dates.length >= count) break;
    if (until && cursor > until) break;
    if (!exdates.has(cursor)) dates.push(cursor);
    if (count === null && !until) break;
    cursor = addDays(cursor, step);
  }
  return dates;
}

// The feed says "No School", "Schools Closed", "No students attend school" or
// "No Classes for Students" when there is no school. It also runs a PTA
// Holiday Boutique and a Holiday Toy Drive on ordinary school days, so
// matching the word "holiday" would cancel school that is actually running.
// The school runs adult education out of the same building and puts it on
// the same public calendar. It is the one thing on the feed with no bearing
// on a K-8 pupil's day, so it is dropped rather than shown.
//
// Deliberately short. Everything else on this feed is a K-8 school's own
// calendar and applies: the Regents sittings are marked "select gr 8", the
// state exams name grades 3 to 8, staff conference and clerical days are the
// days students get off. Parent evenings and PTA fundraisers stay too, since
// a student having a reason to know about the carnival, the book fair or the
// 11:30 dismissal is the point. Filtering aggressively here would hide real
// events from the people the app is for.
const NOT_FOR_STUDENTS = [
  /\badult education\b/i
];

const CLOSED = /\bno school\b|\bschools? closed\b|\bno students attend\b|\bno classes for students\b/i;
// "…11:30 AM Student Dismissal" is a short day, not a closure.
const EARLY = /\bdismissal\b|\bearly dismissal\b/i;

function classify(title){
  if (CLOSED.test(title)) return 'closed';
  if (EARLY.test(title)) return 'early';
  return 'event';
}

async function main(){
  const res = await fetch(FEED, {
    headers: { 'user-agent': 'schedule-2.0 calendar sync (github actions)' }
  });
  if (!res.ok) throw new Error(`feed returned ${res.status} ${res.statusText}`);
  const ics = await res.text();
  if (!ics.includes('BEGIN:VCALENDAR')) throw new Error('response is not an iCalendar document');

  const events = parseEvents(ics);
  if (!events.length) throw new Error('no VEVENTs in the feed');

  const rows = [];
  const skipped = [];
  for (const e of events){
    if (!e.DTSTART || !e.SUMMARY) continue;
    const start = localDate(e.DTSTART.value);
    if (!start) continue;
    const title = unescapeText(e.SUMMARY.value);
    if (!title) continue;
    if (NOT_FOR_STUDENTS.some(re => re.test(title))){ skipped.push(title); continue; }

    const exdates = new Set();
    (e.EXDATE || []).forEach(p => {
      p.value.split(',').forEach(v => {
        const d = localDate(v.trim());
        if (d) exdates.add(d);
      });
    });

    const kind = classify(title);
    const allDay = (e.DTSTART.params.VALUE || '').toUpperCase() === 'DATE';
    const time = allDay ? null : (/T(\d{2})(\d{2})/.exec(e.DTSTART.value)
      ? `${/T(\d{2})(\d{2})/.exec(e.DTSTART.value)[1]}:${/T(\d{2})(\d{2})/.exec(e.DTSTART.value)[2]}`
      : null);

    for (const date of occurrences(start, e.RRULE && e.RRULE.value, exdates)){
      rows.push({ date, title, kind, ...(time ? { time } : {}) });
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  // the same day can carry duplicates across overlapping entries
  const seen = new Set();
  const unique = rows.filter(r => {
    const k = r.date + '|' + r.title;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const nameProp = /X-WR-CALNAME:(.+)/.exec(unfold(ics));
  const payload = {
    name: nameProp ? unescapeText(nameProp[1]) : 'School calendar',
    source: FEED,
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    events: unique
  };

  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, JSON.stringify(payload, null, 1) + '\n');
  const closed = unique.filter(r => r.kind === 'closed').length;
  console.log(`${unique.length} dates (${closed} no-school), ${payload.events[0].date} to ${payload.events[unique.length-1].date}`);
  if (skipped.length){
    console.log(`skipped ${skipped.length} not for students: ${[...new Set(skipped)].join('; ')}`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
