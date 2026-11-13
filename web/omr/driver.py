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
from homr.autocrop import autocrop  # noqa: E402
from homr.main import ProcessingConfig, process_image, run_homr  # noqa: E402
from homr.music_xml_generator import XmlGeneratorArguments  # noqa: E402


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
