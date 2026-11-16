"""Score wake-word models on the same stream test as train.py (cached by it): held-out "Quisk" clips and sound-alikes,
each in 3.5 s of background, and ~19 h of unseen LibriSpeech speakers. A wake needs N steps in a row above the
threshold, then 2 s pass before the next one.
Usage: python evaluate.py CACHE_DIR MODEL.onnx [MODEL.onnx ...]"""
import os, sys
import numpy as np
import onnxruntime as ort

cache = sys.argv[1]
split = lambda flat, lens: np.split(flat, np.cumsum(lens)[:-1])
cs = np.load(os.path.join(cache, "clip_streams.npz"))
pos, hard = split(cs["pos"], cs["pos_lens"]), split(cs["hard"], cs["hard_lens"])
speech = split(np.load(os.path.join(cache, "test_streams.npy")), np.load(os.path.join(cache, "test_lens.npy")))
hours = sum(len(e) for e in speech) * 0.08 / 3600


def triggers(s, thr, need):
    n, run, last = 0, 0, -999
    for i, v in enumerate(s):
        run = run + 1 if v > thr else 0
        if run >= need and i - last > 25:
            n, last, run = n + 1, i, 0
    return n


for path in sys.argv[2:]:
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    score = lambda w: np.concatenate([sess.run(["score"], {"embeddings": w[i: i + 8192].astype(np.float32)})[0].reshape(-1)
                                      for i in range(0, len(w), 8192)])
    windows = lambda e: np.lib.stride_tricks.sliding_window_view(e, (16, 96))[:, 0]
    sp, sh = [score(x) for x in pos], [score(x) for x in hard]
    ss = [score(windows(e)) for e in speech]
    print(f"\n{path}  ({hours:.1f} h of speech)\n need  thr   recall  soundalike  false/h")
    for need in (1, 2, 3):
        for thr in (0.5, 0.8, 0.9, 0.95, 0.98):
            print(f"  {need}   {thr:.2f}  {np.mean([triggers(s, thr, need) > 0 for s in sp]):.3f}   "
                  f"{np.mean([triggers(s, thr, need) > 0 for s in sh]):.3f}      "
                  f"{sum(triggers(s, thr, need) for s in ss) / hours:.2f}", flush=True)
