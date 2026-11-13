"""Runs homr on page images that the app has written into the in-memory file system."""

import os
import sys
import types

# homr imports these at module level but only uses them for features the app
# does not need on the phone (model download, its own PDF rendering, title OCR).
for _name in ("requests", "pypdfium2", "rapidocr"):
    if _name not in sys.modules:
        _stub = types.ModuleType(_name)
        _stub.RapidOCR = object
        _stub.exceptions = types.SimpleNamespace(RequestException=Exception)
        sys.modules[_name] = _stub

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from homr.autocrop import autocrop  # noqa: E402
from homr.main import ProcessingConfig, process_image, run_homr  # noqa: E402
from homr.music_xml_generator import XmlGeneratorArguments  # noqa: E402
from homr import main as homr_main  # noqa: E402
from homr import staff_parsing  # noqa: E402
from homr.segmentation import inference_segnet  # noqa: E402
from homr.simple_logging import eprint  # noqa: E402
from homr.transformer import staff2score  # noqa: E402
from homr.transformer.decoder_inference import detokenize  # noqa: E402
from homr.transformer.vocabulary import EncodedSymbol  # noqa: E402

# Patches of the page with nothing on them (margins, the table around a photo,
# space under the last system) are skipped instead of being run through the
# segmentation network: a blank patch can only contain background anyway.
DARK_SHARE = 0.001  # a patch with fewer ink pixels than this share counts as blank


def _is_blank(patch):
    sample = patch[0, ::4, ::4]
    ink = sample < np.median(sample) - 80
    return ink.mean() < DARK_SHARE


# Several helper workers (pool.js) can run the networks side by side, one per
# spare processor core. Inside the app `ortBridge` is set up by worker.js; when
# this file runs elsewhere (tests on a computer) everything runs in-process.
try:
    from js import ortBridge
    from pyodide.ffi import run_sync, to_js

    HELPERS = int(ortBridge.poolSize)
except ImportError:
    HELPERS = 1


def _staff_network_files():
    from homr.transformer.configs import Config

    paths = Config().filepaths
    return [os.path.basename(paths.encoder_path), os.path.basename(paths.decoder_path)]


def preload():
    """Lets the helpers load the networks while the page is being prepared."""
    if HELPERS > 1:
        ortBridge.preload(to_js([os.path.basename(inference_segnet.segnet_path_onnx)]))


def _preload_staff_networks():
    ortBridge.preload(to_js(_staff_network_files()))


def _segment_on_helpers(patches, win_size):
    stacked = np.ascontiguousarray(np.stack(patches, axis=0), dtype=np.float32)
    model = os.path.basename(inference_segnet.segnet_path_onnx)
    labels = run_sync(ortBridge.segment(model, to_js(stacked.reshape(-1)), len(patches), win_size))
    return np.asarray(labels.to_py(), dtype=np.uint8).reshape(len(patches), win_size, win_size)


def _inference(image_org, use_gpu_inference, batch_size, step_size, win_size):
    """homr's segmentation step (homr/segmentation/inference_segnet.py), skipping blank patches."""
    global HELPERS  # noqa: PLW0603
    if step_size < 0:
        step_size = win_size // 2

    image_org = cv2.cvtColor(image_org, cv2.COLOR_GRAY2BGR)
    image = np.transpose(image_org, (2, 0, 1)).astype(np.float32)
    _, h, w = image.shape
    blank = np.zeros((win_size, win_size), dtype=np.uint8)
    data = []
    todo = []  # (index in data, patch)
    for y_loop in range(0, max(h, win_size), step_size):
        y = min(y_loop, h - win_size)
        for x_loop in range(0, max(w, win_size), step_size):
            x = min(x_loop, w - win_size)
            patch = inference_segnet.extract_patch(image, y, x, win_size)
            data.append(blank)
            if not _is_blank(patch):
                todo.append((len(data) - 1, patch))
    eprint(f"Segmentation: {len(todo)} patches to read, {len(data) - len(todo)} blank ones skipped")

    labels = None
    if HELPERS > 1:
        _preload_staff_networks()
    if HELPERS > 1 and todo:
        try:
            labels = _segment_on_helpers([p for _, p in todo], win_size)
        except Exception as ex:  # noqa: BLE001 - fall back to reading in this worker
            eprint("Helpers failed, reading on one core:", ex)
            HELPERS = 1
    if labels is None:
        if inference_segnet._segnet_inference is None:
            inference_segnet._segnet_inference = inference_segnet.Segnet(use_gpu_inference)
        net = inference_segnet._segnet_inference
        labels = []
        for start in range(0, len(todo), batch_size):
            out = net.run(np.stack([p for _, p in todo[start : start + batch_size]], axis=0))
            labels.extend(np.argmax(result, axis=0).astype(np.uint8) for result in out)
    for (index, _), label in zip(todo, labels, strict=True):
        data[index] = label

    merged = inference_segnet.merge_patches(data, (int(image_org.shape[0]), int(image_org.shape[1])), win_size, step_size)
    return (
        (merged == 4).astype(np.uint8),  # staff
        (merged == 5).astype(np.uint8),  # symbols
        (merged == 1).astype(np.uint8),  # stems_rests
        (merged == 2).astype(np.uint8),  # notehead
        (merged == 3).astype(np.uint8),  # clefs_keys
    )


inference_segnet.inference = _inference


# ───── Reading the staves side by side ─────
# homr reads one staff at a time (staff_parsing.parse_staffs -> Staff2Score.predict).
# With helpers, parse_staffs runs twice: a first pass only collects the prepared
# staff images, the helpers read them all in parallel, and a second pass hands
# each result back exactly where homr asked for it.

_collect = None  # list of staff images while collecting
_replay = None  # list of results while replaying
_original_init = staff2score.Staff2Score.__init__
_original_predict = staff2score.Staff2Score.predict
_original_parse_staffs = staff_parsing.parse_staffs


def _init(self, config):
    if HELPERS > 1:
        self.config = config  # the networks live in the helpers
    else:
        _original_init(self, config)


def _predict(self, image):
    if _collect is not None:
        _collect.append(staff2score._transform(image=image))
        return []
    if _replay is not None:
        return _replay.pop(0)
    if not hasattr(self, "encoder"):
        _original_init(self, self.config)
    return _original_predict(self, image)


def _symbols(result, config):
    """Turns a helper's token numbers into homr symbols (as ScoreDecoder.generate does)."""
    tokens = np.asarray(result.tokens.to_py(), dtype=np.int64).reshape(-1, 6)
    dims = [int(d) for d in result.attentionDims]
    attention = np.asarray(result.attention.to_py(), dtype=np.float32)
    per_step = int(np.prod(dims)) if dims else 0
    vocab = {
        name: {v: k for k, v in getattr(config, f"{name}_vocab").items()}
        for name in ("rhythm", "pitch", "lift", "position", "articulation", "slur")
    }
    symbols = []
    for step, (rhythm, pitch, lift, position, articulation, slur) in enumerate(tokens):
        word = {}
        for name, token in (("rhythm", rhythm), ("pitch", pitch), ("lift", lift), ("position", position), ("articulation", articulation), ("slur", slur)):
            word[name] = detokenize(np.array([[token]]), vocab[name])[0]
        coordinates = attention[step * per_step : (step + 1) * per_step].reshape(dims) if per_step else None
        symbols.append(EncodedSymbol(coordinates=coordinates, **word))
    return symbols


def _read_staves_on_helpers(images, config):
    paths = config.filepaths
    cfg = {
        "imageDims": list(images[0].shape),
        "dim": int(config.decoder_dim),
        "heads": int(config.decoder_heads),
        "depth": int(config.decoder_depth),
        "maxLen": int(config.max_seq_len),
        "eos": int(config.eos_token),
    }
    flat = [to_js(np.ascontiguousarray(i, dtype=np.float32).reshape(-1)) for i in images]
    results = run_sync(
        ortBridge.staves(os.path.basename(paths.encoder_path), os.path.basename(paths.decoder_path), to_js(flat), to_js(cfg, dict_converter=__import__("js").Object.fromEntries))
    )
    return [_symbols(r, config) for r in results]


def _parse_staffs(debug, staffs, image, config, *args, **kwargs):
    global _collect, _replay, HELPERS  # noqa: PLW0603
    if HELPERS <= 1:
        return _original_parse_staffs(debug, staffs, image, config, *args, **kwargs)
    quiet = staff_parsing.eprint
    _collect = []
    staff_parsing.eprint = lambda *a, **k: None
    try:
        _original_parse_staffs(debug, staffs, image, config, *args, **kwargs)
    except Exception:  # noqa: BLE001, S110 - the first pass only gathers the images
        pass
    finally:
        images, _collect = _collect, None
        staff_parsing.eprint = quiet
    if images:
        eprint(f"Reading {len(images)} staffs on {HELPERS} cores")
        try:
            _replay = _read_staves_on_helpers(images, config)
        except Exception as ex:  # noqa: BLE001 - fall back to reading in this worker
            eprint("Helpers failed, reading on one core:", ex)
            HELPERS = 1
    staff_parsing.eprint = lambda *a, **k: None
    try:
        return _original_parse_staffs(debug, staffs, image, config, *args, **kwargs)
    finally:
        _replay = None
        staff_parsing.eprint = quiet


staff2score.Staff2Score.__init__ = _init
staff2score.Staff2Score.predict = _predict
staff_parsing.parse_staffs = _parse_staffs
homr_main.parse_staffs = _parse_staffs


def recognize(paths, crop):
    """Returns MusicXML text for the pages (in reading order)."""
    paths = list(paths)
    for path, needs_crop in zip(paths, list(crop), strict=True):
        if needs_crop:  # rendered PDF pages have wide empty margins
            cv2.imwrite(path, autocrop(cv2.imread(path)))
    config = ProcessingConfig(False, False, False, False, -1, False, False, False, False)
    xml_args = XmlGeneratorArguments(False, None, None)
    if len(paths) == 1:
        result = process_image(paths[0], config, xml_args)
    else:
        run_homr(paths, config, xml_args)
        result = os.path.splitext(paths[0])[0] + ".musicxml"
    with open(result, encoding="utf-8") as handle:
        return handle.read()
