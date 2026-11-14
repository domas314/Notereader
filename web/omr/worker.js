// Sheet-music recognition, entirely on the device.
//
// Runs the homr recognition engine (Python) inside Pyodide, with its neural
// networks executed by onnxruntime-web. Everything is loaded from ../engine/,
// which ships inside the app - nothing is sent anywhere.

import { loadPyodide } from '../engine/pyodide/pyodide.mjs';
import * as ort from '../engine/ort/ort.wasm.min.mjs';

const ENGINE = new URL('../engine/', import.meta.url).href;
const post = (type, data = {}) => self.postMessage({ type, ...data });

ort.env.wasm.wasmPaths = `${ENGINE}ort/`;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
ort.env.logLevel = 'error';

// ───── Helpers that read parts of the page in parallel (pool.js) ─────
// How many: one per spare processor core, limited by the phone's memory (each
// helper holds its own copy of the networks, about 300 MB) and by the app, which
// lowers the limit if a reading was ever cut short (see reader.js).
// The number is worked out by the app (readingPlan in reader.js) and passed in.
const cores = navigator.hardwareConcurrency || 2;
const requested = Number(new URL(self.location.href).searchParams.get('helpers'));
let POOL_SIZE = Number.isFinite(requested) && requested > 0 ? Math.min(requested, Math.max(1, cores - 1)) : 1;
if (POOL_SIZE < 2) POOL_SIZE = 1; // a single helper would only add memory, not speed

class Helper {
  constructor() {
    this.worker = new Worker(new URL('./pool.js', import.meta.url), { type: 'module' });
    this.calls = new Map();
    this.nextId = 0;
    this.worker.onmessage = ({ data }) => {
      const call = this.calls.get(data.id);
      this.calls.delete(data.id);
      if (data.error) call?.reject(new Error(data.error));
      else call?.resolve(data);
    };
    this.worker.onerror = (e) => {
      for (const call of this.calls.values()) call.reject(new Error(e.message || 'A reading helper stopped'));
      this.calls.clear();
    };
  }
  call(message, transfer = []) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }
}
let helpers = null;
const getHelpers = () => (helpers ??= Array.from({ length: POOL_SIZE }, () => new Helper()));

/** Runs jobs on the helpers, each helper taking the next job when it is free. */
async function onHelpers(jobs, run) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(getHelpers().map(async (helper) => {
    while (next < jobs.length) {
      const index = next++;
      results[index] = await run(helper, jobs[index], index);
    }
  }));
  return results;
}

const DTYPES = { float32: 'float32', float16: 'float16', int64: 'int64', int32: 'int32', uint8: 'uint8', bool: 'bool', float64: 'float64' };
const sessions = new Map();

// What the Python `onnxruntime` stand-in calls.
self.ortBridge = {
  async load(name) {
    if (!sessions.has(name)) {
      post('log', { line: `Loading model ${name}` });
      sessions.set(name, await ort.InferenceSession.create(`${ENGINE}models/${name}`, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      }));
    }
    return sessions.get(name);
  },
  tensor(dtype, data, dims) {
    return new ort.Tensor(DTYPES[dtype] || dtype, data, Array.from(dims));
  },
  poolSize: POOL_SIZE,
  // Starts loading networks in the helpers ahead of time, while other work runs.
  preload(files) {
    if (POOL_SIZE < 2) return;
    for (const h of getHelpers()) h.call({ type: 'load', files: Array.from(files) }).catch(() => {});
  },
  // Segmentation of the page's patches, split across the helpers.
  async segment(file, data, count, size) {
    const per = size * size * 3;
    const chunk = 1; // one patch per call keeps each helper's working memory small
    const jobs = [];
    for (let start = 0; start < count; start += chunk) jobs.push([start, Math.min(chunk, count - start)]);
    const parts = await onHelpers(jobs, (helper, [start, n]) => {
      const slice = data.slice(start * per, (start + n) * per);
      return helper.call({ type: 'segment', file, data: slice, count: n, size }, [slice.buffer]);
    });
    const labels = new Uint8Array(count * size * size);
    parts.forEach((part, i) => labels.set(part.labels, jobs[i][0] * size * size));
    // Free the segmentation network's memory before the staves are read.
    await Promise.all(getHelpers().map((h) => h.call({ type: 'drop', file })));
    return labels;
  },
  // Reads staves side by side; returns, per staff, its symbols as token numbers.
  async staves(encoderFile, decoderFile, images, cfg) {
    let done = 0;
    const list = Array.from(images);
    return onHelpers(list, async (helper, image) => {
      const result = await helper.call({ type: 'staff', encoderFile, decoderFile, image, cfg: cfg.toJs ? cfg.toJs({ dict_converter: Object.fromEntries }) : cfg });
      done += 1;
      post('log', { line: `Read staff ${done} of ${list.length}` });
      return result;
    });
  },
  async run(session, names, tensors, wanted) {
    const feeds = {};
    names.forEach((n, i) => (feeds[n] = tensors[i]));
    const out = await session.run(feeds, Array.from(wanted));
    return Array.from(wanted, (n) => out[n]);
  },
};

let ready;
function boot() {
  ready ??= (async () => {
    if (typeof WebAssembly.Suspending !== 'function') {
      throw new Error('This device\'s browser engine is too old for on-device reading. Update "Android System WebView" (or Chrome) and try again.');
    }
    post('stage', { text: 'Starting the reading engine' });
    const py = await loadPyodide({
      indexURL: `${ENGINE}pyodide/`,
      stdout: (line) => post('log', { line }),
      stderr: (line) => post('log', { line }),
    });
    await py.loadPackage(['numpy', 'opencv-python', 'pillow'], { messageCallback: () => {} });
    const [wheel, typing, shim, driver] = await Promise.all([
      fetch(`${ENGINE}homr.whl`).then((r) => r.arrayBuffer()),
      fetch(`${ENGINE}typing_extensions.whl`).then((r) => r.arrayBuffer()),
      fetch(new URL('./onnxruntime.py', import.meta.url)).then((r) => r.text()),
      fetch(new URL('./driver.py', import.meta.url)).then((r) => r.text()),
    ]);
    py.unpackArchive(wheel, 'wheel');
    py.unpackArchive(typing, 'wheel');
    const site = py.runPython('import site; site.getsitepackages()[0]');
    py.FS.writeFile(`${site}/onnxruntime.py`, shim);
    py.FS.writeFile(`${site}/notereader_driver.py`, driver);
    py.FS.mkdirTree('/work');
    await py.runPythonAsync('import notereader_driver');
    return py;
  })();
  return ready;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'warmup') {
    boot().catch(() => {});
    return;
  }
  if (data.type !== 'recognize') return;
  try {
    const py = await boot();
    for (const name of py.FS.readdir('/work')) if (!name.startsWith('.')) py.FS.unlink(`/work/${name}`);
    const paths = data.pages.map((page, i) => {
      const path = `/work/page_${String(i).padStart(3, '0')}.${page.ext}`;
      py.FS.writeFile(path, new Uint8Array(page.bytes));
      return path;
    });
    py.runPython('notereader_driver.preload()');
    py.globals.set('nr_paths', py.toPy(paths));
    py.globals.set('nr_crop', py.toPy(data.pages.map((p) => Boolean(p.crop))));
    const xml = await py.runPythonAsync('notereader_driver.recognize(nr_paths, nr_crop)');
    post('done', { xml });
  } catch (err) {
    post('error', { message: String(err?.message || err).split('\n').filter(Boolean).slice(-3).join('\n') });
  }
};
