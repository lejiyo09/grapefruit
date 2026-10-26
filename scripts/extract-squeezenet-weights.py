"""ndf squeezenet_weights.pkl → 안전하게(numpy 배열 복원만 허용) 읽어 float32 바이너리 + JSON 목차로 저장"""
import pickle, sys, json, io
import numpy as np

ALLOWED = {("numpy.core.multiarray", "_reconstruct"), ("numpy._core.multiarray", "_reconstruct"),
           ("numpy", "ndarray"), ("numpy", "dtype"), ("numpy.core.multiarray", "scalar"), ("numpy._core.multiarray", "scalar"),
           ("collections", "OrderedDict")}

class Safe(pickle.Unpickler):
    def find_class(self, module, name):
        if (module, name) not in ALLOWED:
            raise pickle.UnpicklingError(f"blocked {module}.{name}")
        return super().find_class(module.replace("numpy.core", "numpy._core") if module.startswith("numpy.core") else module, name)

src, out_bin, out_json = sys.argv[1:4]
w = Safe(open(src, "rb"), encoding="latin1").load()
index, blobs, off = [], [], 0
for name in sorted(w):
    k, b = w[name]
    k = np.asarray(k, dtype=np.float32); b = np.asarray(b, dtype=np.float32)
    for part, arr in (("kernel", k), ("bias", b)):
        index.append({"name": name, "part": part, "shape": list(arr.shape), "offset": off, "length": int(arr.size)})
        blobs.append(arr.ravel(order="C").tobytes()); off += arr.size
open(out_bin, "wb").write(b"".join(blobs))
json.dump({"source": "ndf 0.1.4 squeezenet_weights.pkl (MIT, Primoz Godec) — Orange Image Analytics local SqueezeNet", "dtype": "float32", "layout": "kernel [h, w, in, out]", "tensors": index}, open(out_json, "w"), indent=1)
print(len(index), off * 4, [ (i["name"], i["part"], i["shape"]) for i in index[:4]])
