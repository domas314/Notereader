import { renderScore, toMEI, editNote, pitchName, getToolkit, tidyScan } from './score.js';
import { Player } from './player.js';
import { listScores, getScore, putScore, deleteScore } from './store.js';
import { readPages, pdfToPages, fetchLink, warmUp, isNative } from './reader.js';
import { checkForUpdate, installedVersion } from './update.js';

const $ = (id) => document.getElementById(id);
const LEVELS = { off: 0, soft: 0.2, full: 1 };
const levelOf = (vol) => (vol <= 0 ? 'off' : vol < 0.6 ? 'soft' : 'full');

const player = new Player();
let current = null; // the open score record
let model = null; // its playback model
let selectedId = null; // note being fixed
let pending = []; // pages waiting to be read: {blob, name, url, pdf}
let scanAbort = null;

function toast(text, ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), ms);
}

function show(view) {
  $('home').hidden = view !== 'home';
  $('player').hidden = view !== 'player';
}

// ═════════════ Library ═════════════

async function refreshLibrary() {
  const scores = await listScores();
  const list = $('library');
  list.replaceChildren();
  for (const s of scores) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'score-item';
    const name = document.createElement('strong');
    name.textContent = s.title;
    const meta = document.createElement('span');
    meta.textContent = new Date(s.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    btn.append(name, meta);
    btn.onclick = () => openScore(s.id);
    li.append(btn);
    list.append(li);
  }
  $('emptyLibrary').hidden = scores.length > 0;
}

function defaultTitle(mei, fallback) {
  const doc = new DOMParser().parseFromString(mei, 'application/xml');
  const title = doc.querySelector('titleStmt > title, title')?.textContent.replace(/\s+/g, ' ').trim();
  if (title && title.length > 1 && title.length < 80) return title;
  return fallback || `Score, ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

async function addScore(data, fallbackTitle) {
  const mei = await toMEI(data);
  const now = Date.now();
  const score = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: defaultTitle(mei, fallbackTitle),
    created: now,
    opened: now,
    mei,
    originalMei: mei,
    settings: {},
  };
  await putScore(score);
  await refreshLibrary();
  await openScore(score.id);
}

// ═════════════ Adding pages & recognition ═════════════

const NOTATION_FILE = /\.(musicxml|xml|mxl|mei)$/i;

/** Shrinks and straightens a phone photo so uploads are fast (the browser applies the camera rotation). */
async function preparePhoto(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const max = 2800;
    const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
    if (blob) return blob;
  } catch { /* fall through: let the server decode it */ }
  return file;
}

async function handleFiles(files) {
  $('scanError').hidden = true;
  for (const file of files) {
    if (NOTATION_FILE.test(file.name)) {
      try {
        await addScore(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ''));
      } catch (err) {
        showScanError(err.message);
      }
      return;
    }
    const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    const blob = pdf ? file : await preparePhoto(file);
    pending.push({ blob, name: file.name, pdf, url: pdf ? null : URL.createObjectURL(blob) });
  }
  if (pending.length) warmUp();
  renderTray();
}

function renderTray() {
  $('tray').hidden = pending.length === 0;
  const list = $('pages');
  list.replaceChildren();
  pending.forEach((page, i) => {
    const li = document.createElement('li');
    const thumb = document.createElement(page.pdf ? 'div' : 'img');
    thumb.className = 'thumb';
    if (page.pdf) thumb.textContent = 'PDF';
    else { thumb.src = page.url; thumb.alt = `Page ${i + 1}`; }
    const label = document.createElement('span');
    label.textContent = page.pdf ? page.name : `Page ${i + 1}`;
    const up = document.createElement('button');
    up.textContent = '↑';
    up.ariaLabel = 'Move earlier';
    up.disabled = i === 0;
    up.onclick = () => { pending.splice(i - 1, 0, pending.splice(i, 1)[0]); renderTray(); };
    const del = document.createElement('button');
    del.textContent = '✕';
    del.ariaLabel = 'Remove page';
    del.onclick = () => { if (page.url) URL.revokeObjectURL(page.url); pending.splice(i, 1); renderTray(); };
    li.append(thumb, label, up, del);
    list.append(li);
  });
  const n = pending.length;
  $('readBtn').textContent = n > 1 ? `Read music (${n} pages)` : 'Read music';
}

function showScanError(text) {
  $('scanError').textContent = text;
  $('scanError').hidden = false;
}

/**
 * Reads pages into a score, on this device. `getPages` produces the page images
 * (it may itself take a while, e.g. rendering a PDF). Resolves true on success.
 */
async function recognize(getPages, title) {
  $('scanError').hidden = true;
  $('tray').hidden = true;
  $('linkChoices').hidden = true;
  $('progress').hidden = false;
  $('progressTitle').textContent = 'Reading the music…';
  const started = Date.now();
  let stage = 'Getting ready';
  const showStage = () => {
    const s = Math.round((Date.now() - started) / 1000);
    $('progressDetail').textContent = `${stage} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const onProgress = (text) => { stage = text; showStage(); };
  const clock = setInterval(showStage, 1000);
  showStage();
  scanAbort = new AbortController();
  const signal = scanAbort.signal;
  let lock = null;
  try {
    lock = await navigator.wakeLock?.request('screen').catch(() => null); // reading takes minutes
    const got = await getPages({ onProgress, signal });
    const pages = Array.isArray(got) ? got : got.pages;
    if (!pages.length) throw new Error('There are no pages to read.');
    const xml = await readPages(pages, { onProgress, signal });
    await addScore(tidyScan(xml), got.title || title);
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') showScanError(err.message);
    return false;
  } finally {
    clearInterval(clock);
    lock?.release().catch(() => {});
    $('progress').hidden = true;
    scanAbort = null;
    renderTray();
  }
}

const photoPage = async (blob) => ({ bytes: await blob.arrayBuffer(), ext: blob.type === 'image/png' ? 'png' : 'jpg' });

async function readMusic() {
  if (!pending.length) return;
  const items = [...pending];
  const done = await recognize(async (options) => {
    const pages = [];
    for (const item of items) {
      if (item.pdf) pages.push(...await pdfToPages(await item.blob.arrayBuffer(), options));
      else pages.push(await photoPage(item.blob));
    }
    return pages;
  }, items.length === 1 && items[0].pdf ? items[0].name.replace(/\.pdf$/i, '') : undefined);
  if (done) {
    for (const p of pending) if (p.url) URL.revokeObjectURL(p.url);
    pending = [];
    renderTray();
  }
}

const titleFromUrl = (url) => {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { /* no title */ }
  return /\.pdf$/i.test(name) ? name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim() : undefined;
};

/** Reads music from a web address: a PDF, an image, or a page that links to PDFs. */
async function readLink(url, title) {
  url = url.trim();
  if (!url) return;
  let choices = null;
  const done = await recognize(async (options) => {
    options.onProgress('Fetching the link');
    const found = await fetchLink(url);
    if (found.kind === 'choices') {
      choices = found.choices;
      throw new DOMException('Needs a choice', 'AbortError');
    }
    title ||= (found.label?.length > 2 && !/\.pdf$/i.test(found.label) ? found.label : null) || titleFromUrl(found.url);
    const pages = found.kind === 'pdf'
      ? await pdfToPages(found.bytes.buffer, options)
      : [await photoPage(await preparePhoto(new Blob([found.bytes], { type: found.type })))];
    return { pages, title };
  });
  if (done) {
    $('linkUrl').value = '';
    $('linkForm').hidden = true;
    $('linkBtn').setAttribute('aria-expanded', 'false');
  } else if (choices) {
    const list = $('linkChoiceList');
    list.replaceChildren();
    for (const choice of choices) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = choice.label;
      btn.onclick = () => readLink(choice.url, choice.label.replace(/\.pdf$/i, ''));
      li.append(btn);
      list.append(li);
    }
    $('linkChoices').hidden = false;
  }
}

function openLinkForm(url = '') {
  $('linkForm').hidden = false;
  $('linkBtn').setAttribute('aria-expanded', 'true');
  if (url) $('linkUrl').value = url;
  else $('linkUrl').focus();
}

// ═════════════ Installing ═════════════

function setupInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || isNative() || localStorage.getItem('installDismissed')) return;
  let promptEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    promptEvent = e;
    $('installCard').hidden = false;
  });
  window.addEventListener('appinstalled', () => ($('installCard').hidden = true));
  $('installBtn').onclick = async () => {
    if (!promptEvent) return;
    promptEvent.prompt();
    await promptEvent.userChoice;
    promptEvent = null;
    $('installCard').hidden = true;
  };
  $('installDismiss').onclick = () => {
    localStorage.setItem('installDismissed', '1');
    $('installCard').hidden = true;
  };
  // iPhone / iPad have no install prompt: explain the manual way.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    $('installHint').textContent = 'In Safari, tap Share, then “Add to Home Screen”.';
    $('installBtn').hidden = true;
    $('installCard').hidden = false;
  }
}

// ═════════════ Updates ═════════════

/** Opens an address outside the app (the phone's browser downloads the new version). */
function openExternal(url) {
  if (isNative()) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
}

/** Looks in the app's GitHub repository for a newer version; `manual` reports every outcome. */
async function lookForUpdate(manual = false) {
  const status = $('updateStatus');
  if (manual) status.textContent = 'Checking…';
  try {
    const result = await checkForUpdate();
    localStorage.setItem('updateChecked', String(Date.now()));
    if (result.available) {
      $('updateText').textContent = `Version ${result.latest} is available (you have ${result.installed}).`;
      $('updateBtn').onclick = () => openExternal(result.apkUrl);
      $('updateCard').hidden = false;
      status.textContent = `Version ${result.latest} is available. Tap Download on the start screen, then open the downloaded file.`;
    } else {
      $('updateCard').hidden = true;
      status.textContent = 'You have the latest version.';
    }
  } catch (err) {
    if (manual) status.textContent = err.message;
  }
}

async function setupUpdates() {
  const info = await installedVersion();
  $('versionText').textContent = info ? `Version ${info.version}` : 'Development copy';
  const cores = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  $('engineInfo').textContent = cores > 1
    ? `Music reading uses ${cores} processor cores.`
    : 'Music reading uses 1 processor core (this phone’s browser engine does not allow more).';
  $('checkUpdateBtn').hidden = !info;
  $('checkUpdateBtn').onclick = () => lookForUpdate(true);
  if (!info || !isNative()) return; // in a browser the page itself is always current
  const last = Number(localStorage.getItem('updateChecked') || 0);
  if (Date.now() - last > 6 * 3600 * 1000) lookForUpdate();
}

// ═════════════ Player view ═════════════

function settings() {
  return current.settings;
}

let saveTimer;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => current && putScore(current), 400);
}

async function openScore(id) {
  const score = await getScore(id);
  if (!score) return;
  current = score;
  current.opened = Date.now();
  selectedId = null;
  player.pause();
  player.posQ = 0;
  $('titleBtn').textContent = current.title;
  $('score').replaceChildren();
  show('player');
  await drawScore(true);
  saveSoon();
}

async function drawScore(firstOpen = false) {
  if (!current) return;
  const wrap = $('scoreWrap');
  const s = settings();
  s.zoom ??= 36;
  const width = Math.max(280, wrap.clientWidth);
  let result;
  try {
    result = await renderScore(current.mei, width, s.zoom);
  } catch (err) {
    toast(err.message);
    return;
  }
  model = result.model;
  $('score').innerHTML = result.pages.join('');

  // Keep saved voice choices; fill in defaults for anything new.
  const saved = s.voices || [];
  s.voices = model.voices.map((v, i) => ({
    name: saved[i]?.name || v.name,
    vol: saved[i]?.vol ?? 1,
    oct: saved[i]?.oct ?? v.suggestedOctave,
  }));
  model.voices.forEach((v, i) => (v.name = s.voices[i].name));
  s.bpm ??= model.tempo || 84;
  s.sound ??= 'choir';
  s.metronome ??= false;
  s.countIn ??= true;

  player.load(model, s.voices);
  player.bpm = s.bpm;
  player.sound = s.sound;
  player.metronome = s.metronome;
  player.countIn = s.countIn;

  // Tint every note by voice so the highlight shows who is singing.
  for (const v of model.voices) {
    for (const n of v.notes) {
      const el = document.getElementById(n.id);
      if (el && !el.style.getPropertyValue('--voice')) el.style.setProperty('--voice', v.color);
    }
  }
  $('seek').max = model.endQ;
  renderVoices();
  syncTransport();
  resetHighlight();
  if (firstOpen) wrap.scrollTop = 0;
  if (selectedId) selectNote(selectedId, false);
}

function renderVoices() {
  const s = settings();
  const chips = $('voiceChips');
  const list = $('voiceList');
  chips.replaceChildren();
  list.replaceChildren();
  model.voices.forEach((v, i) => {
    const vs = s.voices[i];
    const level = levelOf(vs.vol);

    const chip = document.createElement('button');
    chip.className = `chip ${level}`;
    chip.style.setProperty('--voice', v.color);
    chip.textContent = vs.name;
    chip.title = 'Tap: full → quiet → off';
    chip.setAttribute('aria-label', `${vs.name}: ${level}`);
    chip.onclick = () => setLevel(i, { full: 'soft', soft: 'off', off: 'full' }[level]);
    chips.append(chip);

    const row = document.createElement('div');
    row.className = 'voice';
    row.style.setProperty('--voice', v.color);
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'voice-name';
    name.textContent = vs.name;
    name.title = 'Rename';
    name.onclick = () => {
      const next = prompt('Name of this voice', vs.name)?.trim();
      if (next) { vs.name = next; v.name = next; renderVoices(); saveSoon(); }
    };
    const seg = document.createElement('div');
    seg.className = 'segmented';
    for (const [key, text] of [['off', 'Off'], ['soft', 'Quiet'], ['full', 'Full']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.setAttribute('aria-pressed', String(level === key));
      b.onclick = () => setLevel(i, key);
      seg.append(b);
    }
    const quick = document.createElement('div');
    quick.className = 'voice-quick';
    const only = document.createElement('button');
    only.type = 'button';
    only.textContent = 'Only';
    only.onclick = () => model.voices.forEach((_, j) => setLevel(j, j === i ? 'full' : 'off', false)) || renderVoices();
    const lead = document.createElement('button');
    lead.type = 'button';
    lead.textContent = 'Lead';
    lead.onclick = () => model.voices.forEach((_, j) => setLevel(j, j === i ? 'full' : 'soft', false)) || renderVoices();
    const octave = document.createElement('div');
    octave.className = 'octave';
    const down = document.createElement('button');
    down.type = 'button';
    down.textContent = '8vb';
    down.title = 'One octave lower';
    const label = document.createElement('span');
    label.textContent = vs.oct === 0 ? 'as written' : `${vs.oct > 0 ? '+' : '−'}${Math.abs(vs.oct)} octave`;
    const up = document.createElement('button');
    up.type = 'button';
    up.textContent = '8va';
    up.title = 'One octave higher';
    const shift = (d) => {
      const oct = Math.max(-2, Math.min(2, vs.oct + d));
      player.setVoice(i, { oct });
      renderVoices();
      saveSoon();
    };
    down.onclick = () => shift(-1);
    up.onclick = () => shift(1);
    octave.append(down, label, up);
    quick.append(only, lead, octave);
    row.append(name, seg, quick);
    list.append(row);
  });
  $('soundSelect').value = s.sound;
}

function setLevel(i, level, redraw = true) {
  player.setVoice(i, { vol: LEVELS[level] });
  saveSoon();
  if (redraw) renderVoices();
  resetHighlight();
}

function setTempo(bpm) {
  player.setTempo(bpm);
  settings().bpm = player.bpm;
  syncTransport();
  saveSoon();
}

function syncTransport() {
  const s = settings();
  $('bpm').textContent = player.bpm;
  $('tempoOut').textContent = player.bpm;
  $('tempoSlider').value = player.bpm;
  $('metroBtn').setAttribute('aria-pressed', String(s.metronome));
  $('countBtn').setAttribute('aria-pressed', String(s.countIn));
  $('playBtn').setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  $('playIcon').innerHTML = player.playing ? '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>' : '<path d="M8 5l11 7-11 7z"/>';
  document.body.classList.toggle('is-playing', player.playing);
}

// ───── Following the music ─────

let lit = new Set();
let cursorIndex = 0;
let lastQ = -1;
let wakeLock = null;
let userScrolledAt = 0;

function resetHighlight() {
  for (const ev of lit) document.getElementById(ev.id)?.classList.remove('playing');
  lit = new Set();
  cursorIndex = 0;
  lastQ = -1;
}

function audible(note) {
  const vs = settings().voices;
  return note.voices.some((v) => vs[v.index].vol > 0);
}

function frame() {
  requestAnimationFrame(frame);
  if (!model || $('player').hidden) return;
  const q = player.currentQ();
  if (q === lastQ) return;
  if (q < lastQ) resetHighlight();
  lastQ = q;

  // `lit` holds the sounding events; a note under a repeat can sound more than once.
  const events = model.events;
  while (cursorIndex < events.length && events[cursorIndex].q0 <= q + 1e-6) {
    const ev = events[cursorIndex++];
    if (ev.q1 > q && audible(ev.note)) {
      lit.add(ev);
      document.getElementById(ev.id)?.classList.add('playing');
    }
  }
  let first = null;
  for (const ev of lit) {
    if (ev.q1 <= q + 1e-6) {
      lit.delete(ev);
      if (![...lit].some((o) => o.id === ev.id)) document.getElementById(ev.id)?.classList.remove('playing');
    } else if (!first) first = ev.id;
  }

  // Count-in display and position read-out.
  const countEl = $('countIn');
  if (player.playing && q < player.startQ) {
    const beatsLeft = Math.ceil((player.startQ - q) / model.beatQ - 1e-6);
    countEl.textContent = model.beatsPerMeasure - beatsLeft + 1;
    countEl.hidden = false;
  } else countEl.hidden = true;

  if (!seeking) $('seek').value = Math.max(0, q);
  let bar = 0;
  while (bar + 1 < model.measures.length && model.measures[bar + 1].q <= q + 1e-6) bar++;
  $('measureLabel').textContent = `bar ${model.measures[bar]?.n || bar + 1}`;

  if (first && player.playing && Date.now() - userScrolledAt > 2500) follow(first);
}

/** Scrolls so the system being sung stays in view. */
function follow(id) {
  const el = document.getElementById(id);
  const wrap = $('scoreWrap');
  const system = el?.closest('g.system');
  if (!system) return;
  const box = system.getBoundingClientRect();
  const view = wrap.getBoundingClientRect();
  if (box.top < view.top + 4 || box.bottom > view.bottom - 4) {
    const target = wrap.scrollTop + box.top - view.top - Math.max(12, (view.height - box.height) / 4);
    follow.auto = Date.now();
    wrap.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }
}

async function togglePlay() {
  if (!model) return;
  if (player.playing) {
    player.pause();
  } else {
    closeEditor();
    userScrolledAt = 0;
    player.play();
    // Keep the screen on while playing; don't wait for it (it can be slow to answer).
    navigator.wakeLock?.request('screen').then((lock) => {
      if (player.playing) wakeLock = lock;
      else lock.release().catch(() => {});
    }, () => {});
  }
  syncTransport();
}

player.onStop = (finished) => {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (finished) resetHighlight();
  syncTransport();
};

// ───── Tapping notes: jump there, and fix mistakes ─────

function noteAt(x, y) {
  const direct = document.elementFromPoint(x, y)?.closest?.('g.note');
  if (direct && model.byId.has(direct.id)) return direct.id;
  let best = null;
  let bestD = 26; // px: fingers are bigger than note heads
  for (const n of model.notes) {
    const head = document.getElementById(n.id)?.querySelector('.notehead') || document.getElementById(n.id);
    if (!head) continue;
    const r = head.getBoundingClientRect();
    if (r.bottom < y - 40 || r.top > y + 40) continue;
    const d = Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y);
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

function selectNote(id, sound = true) {
  document.querySelector('g.note.selected')?.classList.remove('selected');
  const n = model.byId.get(id);
  if (!n) return closeEditor();
  selectedId = id;
  document.getElementById(id)?.classList.add('selected');
  const vs = settings().voices[n.voices[0].index];
  $('editLabel').textContent = `${n.voices.map((v) => v.name).join(' + ')} · ${pitchName(n.pitch + 12 * vs.oct)}`;
  $('editBar').hidden = false;
  if (sound) player.preview(n.pitch + 12 * vs.oct);
}

function closeEditor() {
  selectedId = null;
  document.querySelector('g.note.selected')?.classList.remove('selected');
  $('editBar').hidden = true;
}

function onScoreTap(e) {
  if (!model) return;
  const id = noteAt(e.clientX, e.clientY);
  if (!id) return closeEditor();
  // Under a repeat the same note sounds several times: go to the time it sounds
  // next from here (or the first time, if it doesn't come again).
  const times = model.events.filter((ev) => ev.id === id);
  const here = player.currentQ();
  const next = times.find((ev) => ev.q0 >= here - 1e-6) || times[0];
  if (next) player.seek(next.q0);
  if (!player.playing) selectNote(id);
}

async function applyEdit(op) {
  if (op === 'close' || !selectedId) return closeEditor();
  const id = selectedId;
  const mei = editNote(current.mei, id, op);
  if (!mei) return;
  const wrap = $('scoreWrap');
  const scroll = wrap.scrollTop;
  current.mei = mei;
  if (op === 'delete') selectedId = null;
  await drawScore();
  wrap.scrollTop = scroll;
  if (op === 'delete') closeEditor();
  await putScore(current);
}

// ═════════════ Wiring ═════════════

let seeking = false;

function holdRepeat(button, action) {
  let timer;
  let interval;
  const stop = () => { clearTimeout(timer); clearInterval(interval); };
  button.addEventListener('pointerdown', () => {
    action();
    timer = setTimeout(() => (interval = setInterval(action, 70)), 400);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(ev, stop);
}

function init() {
  $('cameraBtn').onclick = () => $('cameraInput').click();
  $('filesBtn').onclick = () => $('filesInput').click();
  for (const input of [$('cameraInput'), $('filesInput')]) {
    input.onchange = async () => {
      const files = [...input.files];
      input.value = '';
      await handleFiles(files);
    };
  }
  $('readBtn').onclick = readMusic;
  $('linkBtn').onclick = () => ($('linkForm').hidden ? openLinkForm() : ($('linkForm').hidden = true, $('linkBtn').setAttribute('aria-expanded', 'false')));
  $('linkForm').onsubmit = (e) => { e.preventDefault(); readLink($('linkUrl').value); };
  setupInstall();
  // A link shared to the installed app (Android "Share" menu) arrives in the address.
  const shared = new URLSearchParams(location.search);
  const sharedUrl = [shared.get('url'), shared.get('text')].join(' ').match(/https?:\/\/\S+/)?.[0];
  if (sharedUrl) {
    history.replaceState(null, '', location.pathname);
    openLinkForm(sharedUrl);
  }
  $('cancelBtn').onclick = () => scanAbort?.abort();
  $('sampleBtn').onclick = async () => {
    try {
      await addScore(await fetch('sample.musicxml').then((r) => r.text()), 'Sample hymn');
    } catch (err) { toast(err.message); }
  };

  $('settingsBtn').onclick = () => $('settingsDialog').showModal();
  setupUpdates();
  document.addEventListener('resume', setupUpdates); // app brought back to the foreground

  $('backBtn').onclick = async () => {
    player.pause();
    closeEditor();
    if (current) await putScore(current);
    current = null;
    model = null;
    show('home');
    refreshLibrary();
  };
  const rename = () => {
    const next = prompt('Name of this score', current.title)?.trim();
    if (next) { current.title = next; $('titleBtn').textContent = next; saveSoon(); }
  };
  $('titleBtn').onclick = rename;
  const zoom = (d) => {
    settings().zoom = Math.max(22, Math.min(70, settings().zoom + d));
    saveSoon();
    drawScore();
  };
  $('zoomOutBtn').onclick = () => zoom(-5);
  $('zoomInBtn').onclick = () => zoom(5);
  $('moreBtn').onclick = () => $('moreDialog').showModal();
  $('moreDialog').onclose = async () => {
    const action = $('moreDialog').returnValue;
    $('moreDialog').returnValue = '';
    if (action === 'rename') rename();
    else if (action === 'export') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([current.mei], { type: 'application/xml' }));
      a.download = `${current.title.replace(/[^\w\- ]+/g, '') || 'score'}.mei`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } else if (action === 'reset') {
      if (current.mei !== current.originalMei && confirm('Undo every note fix and go back to the scan?')) {
        current.mei = current.originalMei;
        closeEditor();
        await drawScore();
        await putScore(current);
      }
    } else if (action === 'delete') {
      if (confirm(`Delete “${current.title}”?`)) {
        player.pause();
        await deleteScore(current.id);
        current = null;
        model = null;
        show('home');
        refreshLibrary();
      }
    }
  };

  $('playBtn').onclick = togglePlay;
  $('restartBtn').onclick = () => { player.seek(0); $('scoreWrap').scrollTo({ top: 0, behavior: 'smooth' }); };
  $('metroBtn').onclick = () => {
    settings().metronome = player.metronome = !player.metronome;
    syncTransport();
    saveSoon();
  };
  $('countBtn').onclick = () => {
    settings().countIn = player.countIn = !player.countIn;
    syncTransport();
    saveSoon();
  };
  holdRepeat($('tempoDown'), () => setTempo(player.bpm - 1));
  holdRepeat($('tempoUp'), () => setTempo(player.bpm + 1));
  $('tempoValue').onclick = () => $('voicesDialog').showModal();
  $('tempoSlider').oninput = (e) => setTempo(Number(e.target.value));
  $('voicesBtn').onclick = () => $('voicesDialog').showModal();
  $('soundSelect').onchange = (e) => {
    settings().sound = player.sound = e.target.value;
    saveSoon();
  };

  const seek = $('seek');
  seek.addEventListener('pointerdown', () => (seeking = true));
  seek.addEventListener('input', () => { seeking = true; });
  seek.addEventListener('change', () => {
    // Snap to the start of the bar so entries are easy to pick up.
    const q = Number(seek.value);
    const bar = [...model.measures].reverse().find((m) => m.q <= q + 1e-6);
    player.seek(bar ? bar.q : q);
    seeking = false;
    const ev = model.events.find((e) => e.q0 >= player.posQ - 1e-6);
    if (ev) follow(ev.id);
  });

  $('score').addEventListener('click', onScoreTap);
  $('editBar').addEventListener('click', (e) => {
    const op = e.target.closest('button')?.dataset.edit;
    if (op) applyEdit(op);
  });
  $('scoreWrap').addEventListener('scroll', () => {
    if (Date.now() - (follow.auto || 0) > 900) userScrolledAt = Date.now();
  }, { passive: true });

  // Re-engrave when the phone is rotated or the window resized.
  let lastWidth = 0;
  let resizeTimer;
  new ResizeObserver(() => {
    const w = $('scoreWrap').clientWidth;
    if (!current || !w || Math.abs(w - lastWidth) < 8) { lastWidth ||= w; return; }
    lastWidth = w;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => drawScore(), 250);
  }).observe($('scoreWrap'));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && current) putScore(current);
  });
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !$('player').hidden && !document.querySelector('dialog[open]') && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      togglePlay();
    }
  });

  refreshLibrary();
  requestAnimationFrame(frame);
  getToolkit().catch((err) => toast(err.message, 6000)); // warm up the engraver
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !isNative()) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
