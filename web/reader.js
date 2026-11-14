// Reading sheet music on the device: turns photos, PDFs and web links into
// MusicXML without sending anything to a server. The heavy work happens in a
// background worker (omr/worker.js) so the screen stays responsive.

const ENGINE = new URL('./engine/', import.meta.url).href;
export const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());

// Reading in parallel needs more memory. If the app was closed by the phone in
// the middle of a reading (most likely for lack of memory), the next readings use
// fewer helpers. `readingWith` is set while a reading runs and cleared after it.
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not essential */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* not essential */ } },
};
function helperLimit() {
  let limit = Number(store.get('helperLimit') || 3);
  if (store.get('readingWith')) {
    limit = limit >= 3 ? 2 : 1; // the last reading never finished
    store.set('helperLimit', String(limit));
    store.del('readingWith');
  }
  return limit;
}

/**
 * How many processor cores reading uses. Parallel helpers (omr/pool.js), one per
 * spare core, limited by the memory the phone reports (each needs ~300 MB) and
 * lowered if a reading was ever cut short.
 */
export function readingPlan() {
  const cores = navigator.hardwareConcurrency || 2;
  const memory = navigator.deviceMemory || 4; // GB, rounded down to 2, 4 or 8 by the browser
  const byMemory = memory >= 8 ? 3 : memory >= 4 ? 2 : 1;
  const limit = Number(store.get('helperLimit') || 3);
  let helpers = Math.max(1, Math.min(cores - 1, byMemory, limit));
  if (helpers < 2) helpers = 1; // a single helper would only add memory, not speed
  const reason = helpers >= Math.min(cores - 1, 3) ? null
    : limit < byMemory ? 'interrupted'
      : byMemory < cores - 1 ? 'memory' : 'cores';
  return { cores, memory, helpers, reason };
}

/** Lets reading use as many cores as the phone allows again (after an interrupted reading). */
export function resetReadingLimit() {
  store.del('helperLimit');
  if (worker) { worker.terminate(); worker = null; }
}

let worker = null;
function getWorker() {
  if (!worker) {
    const url = new URL('./omr/worker.js', import.meta.url);
    helperLimit(); // applies a lower limit if the last reading was cut short
    url.searchParams.set('helpers', String(readingPlan().helpers));
    worker = new Worker(url, { type: 'module' });
  }
  return worker;
}

/** Starts loading the engine early (a few seconds) so the first scan begins sooner. */
export function warmUp() {
  try { getWorker().postMessage({ type: 'warmup' }); } catch { /* reported when reading */ }
}

function abortError() {
  return new DOMException('Cancelled', 'AbortError');
}

/**
 * Recognizes pages given in reading order.
 * @param {{bytes: ArrayBuffer, ext: string, crop?: boolean}[]} pages
 * @returns {Promise<string>} MusicXML
 */
export function readPages(pages, { onProgress = () => {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const w = getWorker();
    let page = 1;
    let staves = 0;
    const stop = () => { w.terminate(); worker = null; }; // the only way to interrupt the engine
    const finish = (fn, value) => {
      store.del('readingWith');
      signal?.removeEventListener('abort', onAbort);
      w.onmessage = w.onerror = null;
      fn(value);
    };
    const onAbort = () => { stop(); finish(reject, abortError()); };
    signal?.addEventListener('abort', onAbort);

    const where = () => (pages.length > 1 ? `Page ${page} of ${pages.length}: ` : '');
    w.onerror = (e) => { stop(); finish(reject, new Error(e.message || 'The reading engine could not start.')); };
    w.onmessage = ({ data }) => {
      if (data.type === 'stage') onProgress(data.text);
      else if (data.type === 'log') {
        const line = data.line || '';
        let m;
        if ((m = /^Processing .*page_(\d+)/.exec(line))) { page = Number(m[1]) + 1; staves = 0; onProgress(`${where()}looking at the page`); }
        else if (/^Loading model segnet/.test(line) || /^Starting Inference/.test(line) || /^Segmentation:/.test(line)) onProgress(`${where()}finding staves and notes`);
        else if ((m = /^Found (\d+) staffs/.exec(line))) { staves = Number(m[1]); onProgress(`${where()}found ${staves} staves, preparing them`); }
        else if ((m = /^Reading (\d+) staffs on (\d+)/.exec(line))) onProgress(`${where()}reading ${m[1]} staves, ${m[2]} at a time`);
        else if ((m = /^Read staff (\d+) of (\d+)/.exec(line))) onProgress(`${where()}read ${m[1]} of ${m[2]} staves`);
        else if ((m = /^Running TrOmr inference on staff image (\d+)/.exec(line))) {
          onProgress(`${where()}reading staff ${Number(m[1]) + 1}${staves ? ` of ${staves}` : ''}`);
        } else if (/^Merging|^Saved the generated/.test(line)) onProgress('Putting the pages together');
      } else if (data.type === 'done') finish(resolve, data.xml);
      else if (data.type === 'error') {
        const engineProblem = /too old|WebAssembly|fetch|import|memory/i.test(data.message);
        finish(reject, new Error(engineProblem ? data.message
          : 'Could not find readable music here. Try a sharper, flatter, well-lit photo with the whole page visible.'));
      }
    };
    store.set('readingWith', '1');
    const transfer = pages.map((p) => p.bytes);
    w.postMessage({ type: 'recognize', pages }, transfer);
  });
}

// ───── PDFs ─────

const MAX_PDF_PAGES = 30;

/** Renders each PDF page to an image the engine can read (about 300 dpi). */
export async function pdfToPages(data, { onProgress = () => {}, signal } = {}) {
  const pdfjs = await import(`${ENGINE}pdfjs/pdf.min.mjs`);
  pdfjs.GlobalWorkerOptions.workerSrc = `${ENGINE}pdfjs/pdf.worker.min.mjs`;
  const task = pdfjs.getDocument({ data: new Uint8Array(data), wasmUrl: `${ENGINE}pdfjs/wasm/` });
  const doc = await task.promise
    .catch(() => { throw new Error('This PDF could not be opened (it may be damaged or password-protected).'); });
  try {
    if (doc.numPages > MAX_PDF_PAGES) throw new Error(`This PDF has ${doc.numPages} pages; at most ${MAX_PDF_PAGES} can be read at once.`);
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      if (signal?.aborted) throw abortError();
      onProgress(`Opening PDF page ${i} of ${doc.numPages}`);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(300 / 72, 3400 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const canvasContext = canvas.getContext('2d');
      canvasContext.fillStyle = '#fff';
      canvasContext.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext, viewport }).promise;
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      pages.push({ bytes: await blob.arrayBuffer(), ext: 'png', crop: true });
      page.cleanup();
      canvas.width = canvas.height = 0;
    }
    return pages;
  } finally {
    task.destroy().catch(() => {});
  }
}

// ───── Web links ─────

const isPdf = (bytes) => {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).trimStart();
  return head.startsWith('%PDF-');
};

/** Downloads a web address. The installed app can fetch any site; a browser only those that permit it. */
async function httpGet(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('That is not a web address. It should start with https://');
  const http = window.Capacitor?.Plugins?.CapacitorHttp;
  if (isNative() && http) {
    let res;
    try {
      res = await http.request({
        url, method: 'GET', responseType: 'arraybuffer', connectTimeout: 15000, readTimeout: 45000,
        headers: { Accept: 'application/pdf,text/html;q=0.9,image/*;q=0.8,*/*;q=0.5' },
      });
    } catch {
      throw new Error('The website did not answer. Check the address and your connection.');
    }
    if (res.status === 401 || res.status === 403) throw new Error('The website does not allow this file to be downloaded (it may need a login).');
    if (res.status >= 400) throw new Error(`The website answered with an error (${res.status}).`);
    let bytes;
    try {
      bytes = Uint8Array.from(atob(String(res.data).replace(/\s/g, '')), (c) => c.charCodeAt(0));
    } catch {
      bytes = new TextEncoder().encode(typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
    }
    const typeKey = Object.keys(res.headers || {}).find((k) => k.toLowerCase() === 'content-type');
    return { bytes, type: (typeKey ? res.headers[typeKey] : '').split(';')[0].trim().toLowerCase(), url: res.url || url };
  }
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('This website cannot be read from a browser. Download the PDF and add it with “Photos / PDF”, or use the installed Android app.');
  }
  if (!res.ok) throw new Error(`The website answered with an error (${res.status}).`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    type: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
    url: res.url || url,
  };
}

function pdfLinksIn(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const baseHref = doc.querySelector('base[href]')?.getAttribute('href');
  const base = baseHref ? new URL(baseHref, pageUrl).href : pageUrl;
  const absolute = (raw) => {
    if (!raw || /^(javascript:|mailto:|data:|#)/i.test(raw.trim())) return null;
    try {
      const u = new URL(raw.trim(), base);
      return /^https?:$/.test(u.protocol) ? u.href : null;
    } catch { return null; }
  };
  const looksPdf = (url, mime = '') => {
    const u = new URL(url);
    let query = u.search;
    try { query = decodeURIComponent(query); } catch { /* keep raw */ }
    return mime === 'application/pdf' || u.pathname.toLowerCase().endsWith('.pdf') || query.toLowerCase().includes('.pdf');
  };
  const pdfs = new Map(); // url -> label
  const frames = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const url = absolute(a.getAttribute('href'));
    if (!url || !looksPdf(url, a.getAttribute('type') || '')) continue;
    const label = (a.textContent || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (!pdfs.get(url)) pdfs.set(url, label);
  }
  for (const el of doc.querySelectorAll('embed, iframe, object')) {
    const url = absolute(el.getAttribute('src') || el.getAttribute('data'));
    if (!url) continue;
    // PDF viewers (pdf.js, Google viewer) carry the real file in ?file= or ?url=
    const inner = [...new URL(url).searchParams].find(([k, v]) => ['file', 'url', 'src'].includes(k) && v.toLowerCase().includes('.pdf'));
    const innerUrl = inner && absolute(inner[1]);
    if (innerUrl) { if (!pdfs.has(innerUrl)) pdfs.set(innerUrl, ''); }
    else if (looksPdf(url, el.getAttribute('type') || '')) { if (!pdfs.has(url)) pdfs.set(url, ''); }
    else frames.push(url);
  }
  const fileName = (url) => decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
  return {
    choices: [...pdfs].slice(0, 40).map(([url, label]) => ({ url, label: label.length > 2 ? label : fileName(url) })),
    frames,
  };
}

/**
 * Finds the music behind a web address.
 * @returns {Promise<{kind: 'pdf'|'image', bytes: Uint8Array, url: string} | {kind: 'choices', choices: {url, label}[]}>}
 */
export async function fetchLink(address) {
  let url = address.trim();
  if (url && !url.includes('://')) url = `https://${url}`;
  const found = await httpGet(url);
  if (isPdf(found.bytes)) return { kind: 'pdf', bytes: found.bytes, url: found.url };
  if (found.type.startsWith('image/')) return { kind: 'image', bytes: found.bytes, url: found.url, type: found.type };
  const text = new TextDecoder().decode(found.bytes);
  if (!/html/.test(found.type) && !/<html|<body|<a\s/i.test(text.slice(0, 5000))) {
    throw new Error('That link is not a PDF, an image, or a web page.');
  }
  const { choices, frames } = pdfLinksIn(text, found.url);
  if (!choices.length) {
    // Some sites show the PDF inside a frame whose address doesn't end in .pdf
    for (const frame of frames.slice(0, 3)) {
      const inner = await httpGet(frame).catch(() => null);
      if (inner && isPdf(inner.bytes)) return { kind: 'pdf', bytes: inner.bytes, url: inner.url };
    }
    throw new Error('No PDF was found on that page. Open the PDF itself and copy its address.');
  }
  if (choices.length === 1) {
    const only = await httpGet(choices[0].url);
    if (!isPdf(only.bytes)) throw new Error('The PDF on that page could not be downloaded (it may need a login).');
    return { kind: 'pdf', bytes: only.bytes, url: only.url, label: choices[0].label };
  }
  return { kind: 'choices', choices };
}
