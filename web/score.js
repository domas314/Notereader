// Score model: loads notation with Verovio, renders it, and works out which
// notes belong to which choir voice and when each one sounds.

const MEI_NS = 'http://www.music-encoding.org/ns/mei';
export const VOICE_COLORS = ['#c8324b', '#d07a12', '#1d8a5b', '#2b6fd6', '#8a4fc7', '#0e8f9c', '#a8577a', '#6b7a1e'];

let toolkitPromise;

/** Resolves with a ready Verovio toolkit (the engraving engine, loaded once). */
export function getToolkit() {
  toolkitPromise ??= new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      try {
        const tk = new window.verovio.toolkit();
        tk.getVersion();
        resolve(tk);
      } catch (err) {
        if (Date.now() - started > 30000) reject(new Error('The notation engine failed to load'));
        else setTimeout(attempt, 60);
      }
    };
    attempt();
  });
  return toolkitPromise;
}

/** Converts MusicXML text, compressed MusicXML (.mxl) bytes or MEI into MEI text. */
export async function toMEI(data) {
  const tk = await getToolkit();
  let ok;
  if (data instanceof ArrayBuffer) {
    const bytes = new Uint8Array(data);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) ok = tk.loadZipDataBuffer(data);
    else ok = tk.loadData(new TextDecoder().decode(bytes));
  } else {
    ok = tk.loadData(data);
  }
  if (!ok) throw new Error('This file does not contain readable music notation');
  const mei = tk.getMEI();
  if (!/<note[\s>]/.test(mei)) throw new Error('No notes were found');
  return mei;
}

/** Engraves the MEI to fit `widthPx` and returns the SVG pages plus the playback model. */
export async function renderScore(mei, widthPx, scale) {
  const tk = await getToolkit();
  tk.setOptions({
    scale,
    pageWidth: Math.round((widthPx * 100) / scale),
    pageHeight: 60000,
    adjustPageHeight: true,
    breaks: 'auto',
    header: 'none',
    footer: 'none',
    pageMarginLeft: 40,
    pageMarginRight: 40,
    pageMarginTop: 40,
    pageMarginBottom: 40,
    svgViewBox: true,
    spacingSystem: 14,
  });
  if (!tk.loadData(mei)) throw new Error('Could not open this score');
  const pages = [];
  for (let p = 1; p <= tk.getPageCount(); p++) pages.push(tk.renderToSVG(p));
  return { pages, model: buildModel(tk, mei) };
}

function attr(el, ...names) {
  for (const n of names) {
    const v = el.getAttribute(n);
    if (v) return v;
  }
  return null;
}

function buildModel(tk, mei) {
  tk.renderToMIDI(); // needed before pitches can be queried
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const doc = new DOMParser().parseFromString(mei, 'application/xml');

  // Where every note sits in the score: staff, layer, measure.
  const place = new Map();
  const measureEls = [...doc.querySelectorAll('measure')];
  measureEls.forEach((m, mi) => {
    for (const el of m.querySelectorAll('note')) {
      const id = el.getAttribute('xml:id');
      const staff = Number(el.closest('staff')?.getAttribute('n') || 1);
      const layer = Number(el.closest('layer')?.getAttribute('n') || 1);
      place.set(id, { staff, layer, measure: mi });
    }
  });

  // A note can sound more than once (repeats, first/second endings): the timemap
  // lists every time it is played. `notes` holds each written note once (for
  // voices and editing); `events` holds every time a note sounds, in order.
  const byId = new Map();
  const events = [];
  const open = new Map(); // id -> events still sounding
  const measures = [];
  const measureNumber = new Map(measureEls.map((m, i) => [m.getAttribute('xml:id'), m.getAttribute('n') || String(i + 1)]));
  // Repeated passes are reported with ids like "abc-rend2"; they are the written element "abc".
  const written = (id) => id.replace(/-rend\d+$/, '');
  for (const entry of timemap) {
    if (entry.measureOn) {
      const id = written(entry.measureOn);
      measures.push({ q: entry.qstamp, id, n: measureNumber.get(id) || '' });
    }
    for (const id of (entry.off || []).map(written)) {
      const ev = open.get(id)?.shift();
      if (ev) ev.q1 = entry.qstamp;
    }
    for (const id of (entry.on || []).map(written)) {
      const where = place.get(id);
      if (!where) continue;
      let note = byId.get(id);
      if (!note) {
        const midi = tk.getMIDIValuesForElement(id);
        if (!midi || !midi.pitch) continue;
        note = { id, q0: entry.qstamp, q1: null, pitch: midi.pitch, ...where, voices: [] };
        byId.set(id, note);
      }
      const ev = { id, note, q0: entry.qstamp, q1: null };
      events.push(ev);
      if (!open.has(id)) open.set(id, []);
      open.get(id).push(ev);
    }
  }
  for (const ev of events) if (ev.q1 === null || ev.q1 <= ev.q0) ev.q1 = ev.q0 + 1;
  const notes = [...byId.values()];
  for (const n of notes) {
    const first = events.find((ev) => ev.note === n);
    n.q1 = first.q1; // the first time it sounds decides which voice it belongs to
  }
  notes.sort((a, b) => a.q0 - b.q0 || b.pitch - a.pitch);
  events.sort((a, b) => a.q0 - b.q0 || b.note.pitch - a.note.pitch);
  const endQ = events.reduce((m, ev) => Math.max(m, ev.q1), 0);

  // Meter → where the beats (metronome clicks) fall.
  let count = 4;
  let unit = 4;
  for (const el of doc.querySelectorAll('scoreDef, staffDef, meterSig')) {
    const c = attr(el, 'meter.count') || (el.localName === 'meterSig' ? attr(el, 'count') : null);
    const u = attr(el, 'meter.unit') || (el.localName === 'meterSig' ? attr(el, 'unit') : null);
    if (c && u && Number(c) > 0 && Number(u) > 0) {
      count = Number(c);
      unit = Number(u);
      break;
    }
  }
  const compound = unit === 8 && count > 3 && count % 3 === 0;
  const beatQ = compound ? 1.5 : 4 / unit;
  const beatsPerMeasure = compound ? count / 3 : count;

  let tempo = null;
  const tempoEl = doc.querySelector('tempo[midi\\.bpm], tempo[mm]');
  if (tempoEl) tempo = Math.round(Number(attr(tempoEl, 'midi.bpm', 'mm')));

  const voices = assignVoices(notes, doc);
  return { notes, events, byId, voices, measures, endQ, beatQ, beatsPerMeasure, tempo: tempo > 20 ? tempo : null };
}

/**
 * Splits the notes into singable voices. Open scores have one voice per staff;
 * closed scores (soprano+alto sharing a staff, tenor+bass sharing another) are
 * split into an upper and a lower line per staff. Keyboard staves stay whole.
 */
function assignVoices(notes, doc) {
  const staffNumbers = [...new Set(notes.map((n) => n.staff))].sort((a, b) => a - b);
  const labels = new Map();
  for (const def of doc.querySelectorAll('staffDef')) {
    const n = Number(def.getAttribute('n'));
    const label = def.querySelector('label')?.textContent.trim() || def.getAttribute('label') || '';
    if (n && label && !labels.has(n)) labels.set(n, label);
  }

  const voices = [];
  for (const staff of staffNumbers) {
    const staffNotes = notes.filter((n) => n.staff === staff);
    const onsets = new Map();
    for (const n of staffNotes) {
      if (!onsets.has(n.q0)) onsets.set(n.q0, []);
      onsets.get(n.q0).push(n);
    }
    const groups = [...onsets.values()];
    const share = (min) => groups.filter((g) => g.length >= min).length / groups.length;
    const keyboard = share(3) > 0.15;
    const split = !keyboard && share(2) > 0.15;

    if (!split) {
      const v = { staff, line: 0, keyboard, label: labels.get(staff) || '', notes: staffNotes };
      voices.push(v);
      for (const n of staffNotes) n.voices.push(v);
      continue;
    }

    const upper = { staff, line: 0, keyboard: false, label: '', notes: [] };
    const lower = { staff, line: 1, keyboard: false, label: '', notes: [] };
    voices.push(upper, lower);
    // Which layers are used in each measure tells a lone note's owner.
    const layersIn = new Map();
    for (const n of staffNotes) {
      if (!layersIn.has(n.measure)) layersIn.set(n.measure, new Set());
      layersIn.get(n.measure).add(n.layer);
    }
    const give = (n, ...vs) => {
      for (const v of vs) {
        n.voices.push(v);
        v.notes.push(n);
      }
    };
    for (const q of [...onsets.keys()].sort((a, b) => a - b)) {
      const group = onsets.get(q).sort((a, b) => b.pitch - a.pitch);
      if (group.length >= 2) {
        give(group[0], upper);
        for (const n of group.slice(1)) give(n, lower);
        continue;
      }
      const n = group[0];
      const held = staffNotes.find((o) => o !== n && o.q0 < q && o.q1 > q && o.voices.length === 1);
      const layers = [...layersIn.get(n.measure)].sort((a, b) => a - b);
      if (held) give(n, held.voices[0] === upper ? lower : upper);
      else if (layers.length > 1) give(n, n.layer === layers[0] ? upper : lower);
      else give(n, upper, lower); // both voices sing this note in unison
    }
  }

  // Names: four singing lines are almost always soprano, alto, tenor, bass.
  const singers = voices.filter((v) => !v.keyboard);
  const satb = ['Soprano', 'Alto', 'Tenor', 'Bass'];
  const generic = (label) => !label || /^(voice|part|staff|choir|unnamed)\b/i.test(label) || /^\W*$/.test(label);
  singers.forEach((v, i) => {
    const shared = singers.filter((o) => o.staff === v.staff).length > 1;
    if (singers.length === 4) v.name = !shared && !generic(v.label) ? v.label : satb[i];
    else if (!shared && !generic(v.label)) v.name = v.label;
    else v.name = `Voice ${i + 1}`;
  });
  const keyboards = voices.filter((v) => v.keyboard);
  keyboards.forEach((v, i) => {
    v.name = generic(v.label) ? (keyboards.length > 2 ? `Keyboard ${i + 1}` : i === 0 ? 'Piano (upper)' : 'Piano (lower)') : v.label;
    if (keyboards.length === 1) v.name = generic(v.label) ? 'Piano' : v.label;
  });

  voices.forEach((v, i) => {
    v.index = i;
    v.color = VOICE_COLORS[i % VOICE_COLORS.length];
    // A tenor line written in treble clef sounds an octave lower than written.
    // Scans often miss the little "8" under the clef, so suggest the fix.
    const pitches = v.notes.map((n) => n.pitch).sort((a, b) => a - b);
    const median = pitches[Math.floor(pitches.length / 2)] || 60;
    v.suggestedOctave = /tenor/i.test(v.name) && median >= 66 ? -1 : /bass/i.test(v.name) && median >= 64 ? -1 : 0;
  });
  return voices;
}

// ───────────── Fixing recognition mistakes ─────────────

const STEPS = ['c', 'd', 'e', 'f', 'g', 'a', 'b'];
const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];

function keyAccidental(doc, pname) {
  let sig = '0';
  for (const el of doc.querySelectorAll('scoreDef, staffDef, keySig')) {
    const s = attr(el, 'keysig', 'key.sig') || (el.localName === 'keySig' ? attr(el, 'sig') : null);
    if (s) {
      sig = s;
      break;
    }
  }
  const m = /^(\d)([sf])$/.exec(sig);
  if (!m) return null;
  const n = Number(m[1]);
  const affected = m[2] === 's' ? SHARP_ORDER.slice(0, n) : [...SHARP_ORDER].reverse().slice(0, n);
  return affected.includes(pname) ? m[2] : null;
}

function setAccidental(doc, note, written, sounding) {
  note.removeAttribute('accid');
  note.removeAttribute('accid.ges');
  for (const a of [...note.children]) if (a.localName === 'accid') a.remove();
  if (!written && !sounding) return;
  const el = doc.createElementNS(MEI_NS, 'accid');
  if (written) el.setAttribute('accid', written);
  else el.setAttribute('accid.ges', sounding);
  note.appendChild(el);
}

/** Applies one correction to a note and returns the new MEI text (or null if nothing changed). */
export function editNote(mei, id, op) {
  const doc = new DOMParser().parseFromString(mei, 'application/xml');
  const note = [...doc.querySelectorAll('note')].find((n) => n.getAttribute('xml:id') === id);
  if (!note) return null;

  if (op === 'up' || op === 'down') {
    let step = STEPS.indexOf(note.getAttribute('pname'));
    let oct = Number(note.getAttribute('oct'));
    step += op === 'up' ? 1 : -1;
    if (step > 6) { step = 0; oct++; }
    if (step < 0) { step = 6; oct--; }
    if (oct < 0 || oct > 8) return null;
    note.setAttribute('pname', STEPS[step]);
    note.setAttribute('oct', String(oct));
    setAccidental(doc, note, null, keyAccidental(doc, STEPS[step]));
  } else if (op === 'sharp' || op === 'flat' || op === 'natural') {
    setAccidental(doc, note, { sharp: 's', flat: 'f', natural: 'n' }[op], null);
  } else if (op === 'delete') {
    for (const tie of [...doc.querySelectorAll('tie, slur')]) {
      if (tie.getAttribute('startid') === `#${id}` || tie.getAttribute('endid') === `#${id}`) tie.remove();
    }
    const chord = note.parentNode.localName === 'chord' ? note.parentNode : null;
    if (chord && chord.querySelectorAll('note').length > 1) {
      note.remove();
    } else {
      const target = chord || note;
      const rest = doc.createElementNS(MEI_NS, 'rest');
      for (const name of ['dur', 'dots']) {
        const v = target.getAttribute(name);
        if (v) rest.setAttribute(name, v);
      }
      target.replaceWith(rest);
    }
  } else {
    return null;
  }
  return new XMLSerializer().serializeToString(doc);
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
export function pitchName(midi) {
  return `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

// ───── Correcting known slips in scanned scores ─────

function barlineAt(doc, measure, location) {
  let barline = [...measure.children].find((c) => c.localName === 'barline' && (c.getAttribute('location') || 'right') === location);
  if (!barline) {
    barline = doc.createElement('barline');
    barline.setAttribute('location', location);
    if (location === 'left') measure.insertBefore(barline, measure.firstChild);
    else measure.appendChild(barline);
  }
  return barline;
}

/**
 * Fixes repeat markup the recognition engine gets wrong, so repeats play correctly:
 *  - a start-repeat sign is written on the right of its bar instead of the left
 *    (players would then jump back to the wrong place);
 *  - after a first ending it writes an extra empty bar (heard as a silent bar).
 * Returns the corrected MusicXML text.
 */
export function tidyScan(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return xml;
  const parts = [...doc.querySelectorAll('part')];
  if (!parts.length) return xml;

  // 1. Start-repeat signs belong on the left of the bar.
  for (const repeat of doc.querySelectorAll('barline repeat[direction="forward"]')) {
    const barline = repeat.parentNode;
    if ((barline.getAttribute('location') || 'right') === 'left') continue;
    barlineAt(doc, barline.parentNode, 'left').appendChild(repeat);
    if (!barline.children.length) barline.remove();
  }

  // 2. Drop bars that are empty in every part, keeping their repeat and ending marks.
  const byPart = parts.map((p) => [...p.children].filter((c) => c.localName === 'measure'));
  const count = Math.min(...byPart.map((m) => m.length));
  for (let i = count - 1; i >= 0; i--) {
    if (byPart.some((measures) => measures[i].querySelector('note'))) continue;
    if (byPart.every((measures) => measures.length === 1)) break;
    for (const measures of byPart) {
      const empty = measures[i];
      const prev = measures[i - 1];
      const next = measures[i + 1];
      for (const barline of [...empty.children].filter((c) => c.localName === 'barline')) {
        const target = (barline.getAttribute('location') || 'right') === 'left' ? (next || prev) : (prev || next);
        const where = target === next ? 'left' : 'right';
        const into = barlineAt(doc, target, where);
        for (const child of [...barline.children]) {
          if (child.localName === 'bar-style' && into.querySelector('bar-style')) continue;
          if (child.localName === 'bar-style') into.insertBefore(child, into.firstChild);
          else into.appendChild(child);
        }
      }
      // Clef, key or time changes written in the empty bar apply to the next one.
      if (next) {
        for (const keep of [...empty.children].filter((c) => ['attributes', 'direction'].includes(c.localName)).reverse()) {
          next.insertBefore(keep, next.firstChild);
        }
      }
      empty.remove();
      measures.splice(i, 1);
    }
  }
  for (const measures of byPart) measures.forEach((m, i) => m.setAttribute('number', String(i + 1)));
  return new XMLSerializer().serializeToString(doc);
}
