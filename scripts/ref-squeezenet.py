"""독립적인 NumPy SqueezeNet(ndf 구조) 참조 구현: 브라우저 구현 검증용 기대값 생성"""
import json, sys
import numpy as np
from PIL import Image

W = np.fromfile(sys.argv[1], dtype=np.float32); idx = json.load(open(sys.argv[2]))["tensors"]
T = {}
for t in idx:
    T[(t["name"], t["part"])] = W[t["offset"]:t["offset"] + t["length"]].reshape(t["shape"])

def conv(x, name, stride=1, same=True):
    k, b = T[(name, "kernel")], T[(name, "bias")]
    kh, kw, cin, cout = k.shape
    h, w, _ = x.shape
    if same:
        oh, ow = -(-h // stride), -(-w // stride)
        ph = max((oh - 1) * stride + kh - h, 0); pw = max((ow - 1) * stride + kw - w, 0)
        x = np.pad(x, ((ph // 2, ph - ph // 2), (pw // 2, pw - pw // 2), (0, 0)))
    else:
        oh, ow = (h - kh) // stride + 1, (w - kw) // stride + 1
    out = np.zeros((oh, ow, cout), dtype=np.float64)
    for i in range(kh):
        for j in range(kw):
            patch = x[i:i + stride * oh:stride, j:j + stride * ow:stride, :]
            out += patch @ k[i, j].astype(np.float64)
    return out + b

relu = lambda x: np.maximum(x, 0)
def pool(x, f, s, op):
    h, w, c = x.shape; oh, ow = (h - f) // s + 1, (w - f) // s + 1
    st = np.stack([x[i:i + s * oh:s, j:j + s * ow:s] for i in range(f) for j in range(f)])
    return st.max(0) if op == "max" else st.mean(0)
def fire(x, n):
    sq = relu(conv(x, n + "/squeeze1x1"))
    return np.concatenate([relu(conv(sq, n + "/expand1x1")), relu(conv(sq, n + "/expand3x3"))], axis=-1)

def embed(img):
    x = np.array(img.convert("RGB").resize((227, 227), Image.LANCZOS), dtype=float)[None]
    s = x.copy(); o = x.copy(); o[:, :, 0] = s[:, :, 2]; o[:, :, 2] = s[:, :, 0]   # Orange 전처리 그대로(폭 축 열 0↔2 교환)
    x = (o - [104.006, 116.669, 122.679])[0]
    x = relu(conv(x, "conv1", 2)); x = pool(x, 3, 2, "max")
    x = fire(x, "fire2"); x = fire(x, "fire3"); x = pool(x, 3, 2, "max")
    x = fire(x, "fire4"); x = fire(x, "fire5"); x = pool(x, 3, 2, "max")
    for n in ("fire6", "fire7", "fire8", "fire9"): x = fire(x, n)
    x = conv(x, "conv10", 1, same=False)
    return pool(x, 13, 1, "mean").reshape(-1)

img = Image.open(sys.argv[3])
e = embed(img)
resized = np.array(img.convert("RGB").resize((227, 227), Image.LANCZOS), dtype=np.uint8)
json.dump({"embedding": [round(float(v), 5) for v in e], "resizedHead": resized[:2, :4].reshape(-1).tolist(), "resizedSum": int(resized.astype(np.int64).sum())}, open(sys.argv[4], "w"))
print(e.shape, e[:5], e.argmax())
