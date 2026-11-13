// A helper worker that runs the recognition networks for part of a page.
//
// The main reading worker (worker.js) starts several of these so that patches of
// the page, and the staves on it, are read side by side on different processor
// cores. Each one holds its own copy of the networks it needs.

import * as ort from '../engine/ort/ort.wasm.min.mjs';

const MODELS = new URL('../engine/models/', import.meta.url).href;
ort.env.wasm.wasmPaths = new URL('../engine/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // parallelism comes from running several helpers
ort.env.logLevel = 'error';

const sessions = new Map();
function session(file) {
  if (!sessions.has(file)) {
    sessions.set(file, ort.InferenceSession.create(MODELS + file, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
  }
  return sessions.get(file);
}

/** Segmentation: class of every pixel for a batch of 320×320 patches. */
async function segment({ file, data, count, size }) {
  const net = await session(file);
  const out = await net.run({ [net.inputNames[0]]: new ort.Tensor('float32', data, [count, 3, size, size]) });
  const scores = out[net.outputNames[0]];
  const classes = scores.dims[1];
  const pixels = size * size;
  const labels = new Uint8Array(count * pixels);
  const s = scores.data;
  for (let b = 0; b < count; b++) {
    const base = b * classes * pixels;
    for (let i = 0; i < pixels; i++) {
      let best = 0;
      let top = s[base + i];
      for (let c = 1; c < classes; c++) {
        const v = s[base + c * pixels + i];
        if (v > top) { top = v; best = c; }
      }
      labels[b * pixels + i] = best;
    }
  }
  return { labels };
}

function argmaxLast(tensor) {
  const v = tensor.dims[tensor.dims.length - 1];
  const d = tensor.data;
  const start = d.length - v;
  let best = 0;
  for (let i = 1; i < v; i++) if (d[start + i] > d[start + best]) best = i;
  return best;
}

const int64 = (n, dims) => new ort.Tensor('int64', BigInt64Array.from([BigInt(n)]), dims);

/**
 * Reads one staff: the encoder, then the decoder one symbol at a time
 * (the same greedy decoding as homr's ScoreDecoder.generate).
 */
async function readStaff({ encoderFile, decoderFile, image, cfg }) {
  const [encoder, decoder] = await Promise.all([session(encoderFile), session(decoderFile)]);
  const encoded = await encoder.run({ [encoder.inputNames[0]]: new ort.Tensor('float32', image, cfg.imageDims) });
  const context = encoded[encoder.outputNames[0]];
  const width = context.dims[context.dims.length - 1];
  const reduced = new ort.Tensor('float32', context.data.slice(0, width), [1, 1, width]);

  const headDim = cfg.dim / cfg.heads;
  let cache = Array.from({ length: cfg.depth * 4 }, () => new ort.Tensor('float32', new Float32Array(0), [1, cfg.heads, 0, headDim]));
  let last = { rhythms: 1, pitchs: 0, lifts: 0, articulations: 0, slurs: 0 };
  const tokens = [];
  const attention = [];
  let attentionDims = [];
  for (let step = 0; step < cfg.maxLen; step++) {
    const feeds = { context: step === 0 ? context : reduced, cache_len: int64(step, [1]) };
    for (const [name, value] of Object.entries(last)) feeds[name] = int64(value, [1, 1]);
    cache.forEach((t, i) => (feeds[`cache_in${i}`] = t));
    const out = await decoder.run(feeds);
    cache = cache.map((_, i) => out[`cache_out${i}`]);
    const rhythm = argmaxLast(out.out_rhythms);
    const pitch = argmaxLast(out.out_pitchs);
    const lift = argmaxLast(out.out_lifts);
    const position = argmaxLast(out.out_positions);
    const articulation = argmaxLast(out.out_articulations);
    const slur = argmaxLast(out.out_slurs);
    if (rhythm === cfg.eos) break;
    tokens.push(rhythm, pitch, lift, position, articulation, slur);
    attentionDims = out.attention.dims;
    attention.push(out.attention.data.slice());
    last = { rhythms: rhythm, pitchs: pitch, lifts: lift, articulations: articulation, slurs: slur };
  }
  const flat = new Float32Array(attention.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of attention) { flat.set(a, offset); offset += a.length; }
  return { tokens: Int32Array.from(tokens), attention: flat, attentionDims: Array.from(attentionDims) };
}

self.onmessage = async ({ data }) => {
  try {
    let result;
    if (data.type === 'segment') result = await segment(data);
    else if (data.type === 'staff') result = await readStaff(data);
    else if (data.type === 'load') {
      await Promise.all(data.files.map(session));
      result = {};
    } else if (data.type === 'drop') {
      const s = sessions.get(data.file);
      sessions.delete(data.file);
      if (s) (await s).release();
      result = {};
    }
    const transfer = Object.values(result).filter((v) => ArrayBuffer.isView(v)).map((v) => v.buffer);
    self.postMessage({ id: data.id, ...result }, transfer);
  } catch (err) {
    self.postMessage({ id: data.id, error: String(err?.message || err) });
  }
};
