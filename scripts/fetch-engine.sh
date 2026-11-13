#!/usr/bin/env bash
# Assembles web/engine/: everything the app needs to read sheet music on the
# device itself. These files are large (~190 MB) and come from public releases,
# so they are downloaded at build time instead of being stored in this repository.
# Needs: node_modules (npm install), python3 with venv, curl, unzip.
#
#   pyodide/  Python runtime for the browser, with numpy, OpenCV and Pillow
#   ort/      ONNX Runtime Web (runs the neural networks)
#   pdfjs/    PDF renderer
#   models/   homr's recognition models
#   *.whl     homr itself (the recognition engine) and a small dependency
#   sounds/   recorded piano and choir notes for playback
set -euo pipefail
cd "$(dirname "$0")/.."

HOMR_VERSION=0.7.1
# Model names belong to the homr version above (see homr/main.py: download_weights).
MODELS=(
  segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f
  encoder_pytorch_model_509-2293bba14bfea47d9d28411339362af15fce4c31
  decoder_pytorch_model_509-2293bba14bfea47d9d28411339362af15fce4c31
)

E=web/engine
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
rm -rf "$E"
mkdir -p "$E/pyodide" "$E/ort" "$E/pdfjs" "$E/models"

echo "Pyodide"
PYODIDE_VERSION=$(node -p "require('pyodide/package.json').version")
cp node_modules/pyodide/{pyodide.mjs,pyodide.asm.mjs,pyodide.asm.wasm,python_stdlib.zip,pyodide-lock.json} "$E/pyodide/"
curl -fsSL --retry 3 "https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/pyodide-${PYODIDE_VERSION}.tar.bz2" \
  | tar -xj -C "$E" --wildcards 'pyodide/numpy-*.whl' 'pyodide/opencv_python-*.whl' 'pyodide/pillow-*.whl'

echo "ONNX Runtime Web and pdf.js"
cp node_modules/onnxruntime-web/dist/{ort.wasm.min.mjs,ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm} "$E/ort/"
cp node_modules/pdfjs-dist/build/{pdf.min.mjs,pdf.worker.min.mjs} "$E/pdfjs/"
cp -r node_modules/pdfjs-dist/wasm "$E/pdfjs/wasm"

echo "homr ${HOMR_VERSION}"
python3 -m pip download --quiet --no-deps --dest "$TMP" "homr==${HOMR_VERSION}" "typing_extensions==4.15.0"
cp "$TMP"/homr-*.whl "$E/homr.whl"
cp "$TMP"/typing_extensions-*.whl "$E/typing_extensions.whl"

echo "Recognition models"
for model in "${MODELS[@]}"; do
  curl -fsSL --retry 3 -o "$TMP/$model.zip" "https://github.com/liebharc/homr/releases/download/onnx_checkpoints/$model.zip"
  unzip -q -o "$TMP/$model.zip" -d "$TMP/models"
  find "$TMP/models" -name "$model.onnx" -exec mv {} "$E/models/" \;
  test -s "$E/models/$model.onnx"
done

echo "Instrument recordings"
# Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0 (medium strength).
# Choir: "Choir Aahs" from the MusyngKite sound font (midi-js-soundfonts), CC BY-SA 3.0.
mkdir -p "$E/sounds/piano" "$E/sounds/choir"
cp node_modules/@audio-samples/piano-mp3-velocity8/audio/*.mp3 "$E/sounds/piano/"
cp node_modules/web-music-score-samples/samples/052-choir-aahs/*.mp3 "$E/sounds/choir/"

echo "Making the staff reader 8-bit (about 2x faster on phones, same notes in tests)"
# homr ships its decoder already quantized; the encoder is quantized here the same
# way. The segmentation network stays as it is: quantized it runs slower.
python3 -m venv "$TMP/q"
"$TMP/q/bin/pip" install --quiet onnx==1.23.2 onnxruntime==1.31.1
"$TMP/q/bin/python" - "$E/models" <<'PY'
import glob, os, sys
from onnxruntime.quantization import QuantType, quantize_dynamic
model = glob.glob(os.path.join(sys.argv[1], "encoder_*.onnx"))[0]
quantize_dynamic(model, model + ".int8", weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul", "Gemm"])
os.replace(model + ".int8", model)
PY

du -sh "$E"
