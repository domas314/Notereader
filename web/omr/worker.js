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
    py.globals.set('nr_paths', py.toPy(paths));
    py.globals.set('nr_crop', py.toPy(data.pages.map((p) => Boolean(p.crop))));
    const xml = await py.runPythonAsync('notereader_driver.recognize(nr_paths, nr_crop)');
    post('done', { xml });
  } catch (err) {
    post('error', { message: String(err?.message || err).split('\n').filter(Boolean).slice(-3).join('\n') });
  }
};
