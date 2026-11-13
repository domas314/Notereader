"""Stand-in for the `onnxruntime` Python package inside the browser.

The recognition engine (homr) talks to ONNX Runtime through its Python API.
In the app there is no native ONNX Runtime, so this module forwards the calls
it uses to onnxruntime-web, which the worker exposes as `ortBridge`.
Tensors returned by a model stay on the JavaScript side until Python asks for
their values, so the decoder's cache is not copied back and forth every step.
"""

import os

import numpy as np
from js import ortBridge  # set up by worker.js
from pyodide.ffi import run_sync, to_js


def get_available_providers():
    return ["CPUExecutionProvider"]


def set_default_logger_severity(_level):
    pass


def preload_dlls():
    pass


class SessionOptions:
    pass


class OrtValue:
    def __init__(self, array=None, js_tensor=None):
        self._array = array
        self._js = js_tensor

    @staticmethod
    def ortvalue_from_numpy(array, _device="cpu", _device_id=0):
        return OrtValue(array=array)

    def numpy(self):
        if self._array is None:
            shape = tuple(self._js.dims.to_py())
            self._array = np.asarray(self._js.data.to_py()).reshape(shape)
        return self._array

    def to_js(self):
        if self._js is None:
            a = np.ascontiguousarray(self._array)
            self._js = ortBridge.tensor(str(a.dtype), to_js(a.reshape(-1)), to_js(list(a.shape)))
        return self._js


class _NodeArg:
    def __init__(self, name):
        self.name = name


class IOBinding:
    def __init__(self):
        self.inputs = {}
        self.output_names = []
        self.outputs = []

    def bind_cpu_input(self, name, array):
        self.inputs[name] = OrtValue(array=array)

    def bind_ortvalue_input(self, name, value):
        self.inputs[name] = value

    def bind_output(self, name, _device="cpu", _device_id=0):
        if name not in self.output_names:
            self.output_names.append(name)

    def get_outputs(self):
        return self.outputs


class InferenceSession:
    def __init__(self, path, sess_options=None, providers=None, **_kwargs):
        self._name = os.path.basename(path)
        self._js = run_sync(ortBridge.load(self._name))

    def get_providers(self):
        return get_available_providers()

    def get_inputs(self):
        return [_NodeArg(n) for n in self._js.inputNames]

    def get_outputs(self):
        return [_NodeArg(n) for n in self._js.outputNames]

    def io_binding(self):
        return IOBinding()

    def run_with_iobinding(self, iobinding, run_options=None):
        names = list(iobinding.inputs)
        tensors = [iobinding.inputs[n].to_js() for n in names]
        wanted = list(iobinding.output_names)
        result = run_sync(ortBridge.run(self._js, to_js(names), to_js(tensors), to_js(wanted)))
        iobinding.outputs = [OrtValue(js_tensor=t) for t in result]
        iobinding.inputs = {}
        iobinding.output_names = []

    def run(self, output_names, feeds, run_options=None):
        binding = IOBinding()
        for name, array in feeds.items():
            binding.bind_cpu_input(name, array)
        for name in output_names or [o.name for o in self.get_outputs()]:
            binding.bind_output(name)
        self.run_with_iobinding(binding)
        return [o.numpy() for o in binding.outputs]
