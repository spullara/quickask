"""Train the "Quisk" wake-word classifier on openWakeWord features (frozen mel spectrogram + Google speech embedding).
Each example is 16 embedding frames x 96 (1.28 s of context, one step per 80 ms). Positives end at the end of the
window, so the detector fires as the word ends.

Negatives: synthetic sound-alikes and sentences, noise, and every 160 ms of LibriSpeech train-clean-100 (100 h, CC BY
4.0), some of it with noise and room echo. Training runs in rounds; after each round the windows of real speech that
score highest are mined and weighted up in the next round.
Test: held-out voices, held-out sound-alikes, and false triggers per hour over the LibriSpeech dev/test sets (other
speakers). Writes OUT/quisk.onnx, OUT/report.json, and copies the two feature models next to it.
Usage: python train.py DATA LIBRISPEECH_DIR OUT"""
import glob, json, os, random, shutil, sys, time, zlib
from multiprocessing import Pool
import numpy as np
import soundfile as sf
from scipy.signal import fftconvolve, resample_poly

SR, L = 16000, 32000
TRAIN_SETS, TEST_SETS = ("train-clean-100",), ("dev-clean", "dev-other", "test-clean", "test-other")


def noise(rng, n):
    kind = rng.integers(4)
    w = rng.standard_normal(n).astype(np.float32)
    if kind == 1:  # pink
        f = np.fft.rfft(w); f /= np.maximum(1, np.sqrt(np.arange(len(f)))); w = np.fft.irfft(f, n).astype(np.float32)
    elif kind == 2:  # brown
        w = np.cumsum(w); w -= np.convolve(w, np.ones(400) / 400, mode="same"); w = w.astype(np.float32)
    elif kind == 3:  # hum + hiss
        t = np.arange(n) / SR
        w = (np.sin(2 * np.pi * rng.choice([50, 60, 120]) * t) + 0.1 * w).astype(np.float32)
    return w / (np.abs(w).max() + 1e-9)


def reverb(rng, x):
    rt60 = rng.uniform(0.15, 0.8)
    n = int(rt60 * SR)
    ir = rng.standard_normal(n).astype(np.float32) * np.exp(-6.9 * np.arange(n) / n).astype(np.float32)
    ir[0] = 1.0
    y = fftconvolve(x, ir)[: len(x)]
    return (y / (np.abs(y).max() + 1e-9) * np.abs(x).max()).astype(np.float32)


# --- Worker processes: speech embeddings -----------------------------------------------------------------------------
_feat = None


def _init():
    global _feat
    from openwakeword.utils import AudioFeatures
    _feat = AudioFeatures(inference_framework="onnx", ncpu=1)


def _embed_file(job):
    """One LibriSpeech file -> its embedding frames (T, 96); some files get noise and room echo first."""
    path, seed, augment = job
    rng = np.random.default_rng(seed)
    x = sf.read(path, dtype="float32")[0]
    if augment and rng.random() < 0.35:
        if rng.random() < 0.5:
            x = reverb(rng, x)
        x = x + noise(rng, len(x)) * np.sqrt(np.mean(x ** 2)) * 10 ** (-rng.uniform(5, 25) / 20)
    x = x / (np.abs(x).max() + 1e-9) * rng.uniform(0.1, 0.9)
    return _feat._get_embeddings((x * 32767).astype(np.int16)).astype(np.float16)


def embed_files(files, augment, seed):
    with Pool(max(1, (os.cpu_count() or 4) - 2), initializer=_init) as pool:
        return pool.map(_embed_file, [(f, seed + i, augment) for i, f in enumerate(files)], chunksize=16)


def main():
    import torch
    import openwakeword
    from openwakeword.utils import AudioFeatures

    DATA, LIBRI, OUT = sys.argv[1:4]
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(11)
    random.seed(11)
    torch.manual_seed(11)
    feat = AudioFeatures(inference_framework="onnx", ncpu=os.cpu_count() or 4)

    meta = json.load(open(os.path.join(DATA, "meta.json")))

    def trim(x, thr=0.02):
        on = np.where(np.abs(x) > thr * np.abs(x).max())[0]
        return x[max(0, on[0] - 800): on[-1] + 800] if len(on) else x

    clips = {k: {"train": [], "test": []} for k in ("pos", "hard", "talk")}
    for m in meta:
        clips[m["kind"]][m["split"]].append(trim(sf.read(os.path.join(DATA, m["path"]), dtype="float32")[0]))
    print({k: {s: len(v) for s, v in d.items()} for k, d in clips.items()}, flush=True)

    def files(sets):
        return sorted(f for s in sets for f in glob.glob(os.path.join(LIBRI, "**", s, "**", "*.flac"), recursive=True))

    libri = {"train": files(TRAIN_SETS), "test": files(TEST_SETS)}
    print({s: len(v) for s, v in libri.items()}, "LibriSpeech files", flush=True)
    # Speech heard behind the synthetic clips (a sample; the full sets are used as streams below).
    bg_audio = {s: [sf.read(f, dtype="float32")[0] for f in random.sample(v, min(len(v), 2500))] for s, v in libri.items()}

    def speech_bg(split, n):
        a = bg_audio[split][rng.integers(len(bg_audio[split]))]
        if len(a) < n:
            a = np.tile(a, n // len(a) + 1)
        s = rng.integers(0, len(a) - n + 1)
        return a[s: s + n]

    def background(split, n=L):
        r = rng.random()
        if r < 0.45:
            bg = speech_bg(split, n) * 10 ** (rng.uniform(-30, -6) / 20)
        elif r < 0.75:
            bg = noise(rng, n) * 10 ** (rng.uniform(-45, -15) / 20)
        else:
            bg = noise(rng, n) * 10 ** (-60 / 20)
        if rng.random() < 0.3:
            bg = bg + noise(rng, n) * 10 ** (rng.uniform(-50, -25) / 20)
        return bg.astype(np.float32)

    def augment(x):
        if rng.random() < 0.7:
            f = rng.uniform(0.88, 1.12)
            x = resample_poly(x, 100, int(round(100 * f))).astype(np.float32)
        if rng.random() < 0.5:
            x = reverb(rng, x)
        return x * rng.uniform(0.3, 1.0)

    def window(clip, split, end_aligned=True, n=L, end_at=None):
        """A 2.0 s window with the clip inside: ending 0-240 ms before the window's end, or anywhere (negatives)."""
        bg = background(split, n)
        if clip is not None:
            x = augment(clip)[-(L - 4000):]  # keep the end (where "Quisk" is) and room for the gap after it
            end = end_at or (n - int(rng.uniform(0, 0.24) * SR) if end_aligned else int(rng.uniform(len(x), n)))
            snr = rng.uniform(0, 25)
            level = np.sqrt(np.mean(x ** 2)) + 1e-9
            bgl = np.sqrt(np.mean(bg ** 2)) + 1e-9
            if bgl > 1e-4:
                bg = bg * (level / bgl) * 10 ** (-snr / 20)
            bg[end - len(x): end] += x
        bg = bg / (np.abs(bg).max() + 1e-9) * rng.uniform(0.05, 0.9)
        return (np.clip(bg, -1, 1) * 32767).astype(np.int16)

    def embed(windows):
        return np.concatenate([feat.embed_clips(np.stack(windows[i: i + 512]), batch_size=256)
                               for i in range(0, len(windows), 512)]).astype(np.float32)

    def build(split, scale):
        groups = {
            "pos": [window(c, split) for c in clips["pos"][split] for _ in range(scale["pos"])],
            "hard": [window(c, split, end_aligned=rng.random() < 0.7) for c in clips["hard"][split] for _ in range(scale["hard"])],
            "talk": [window(c, split, end_aligned=rng.random() < 0.5) for c in clips["talk"][split] for _ in range(scale["talk"])],
            "bg": [window(None, split) for _ in range(scale["bg"])],
            # Near misses: "Quisk" cut off or still in progress at the window's end must not fire.
            "early": [window(c[: int(len(c) * rng.uniform(0.3, 0.6))], split)
                      for c in random.sample(clips["pos"][split], min(len(clips["pos"][split]), scale["early"]))],
        }
        return {k: embed(v) for k, v in groups.items() if v}

    def clip_stream(clip):
        """A held-out clip as the app hears it: 3.5 s of background with the clip ending at 2.5 s, every 80 ms step."""
        e = feat._get_embeddings(window(clip, "test", n=56000, end_at=40000)).astype(np.float32)
        return np.lib.stride_tricks.sliding_window_view(e, (16, 96))[:, 0]

    # The slow parts are cached next to OUT for later runs: speech features once, synthetic windows per clip list.
    cache = os.path.join(os.path.dirname(os.path.abspath(OUT)), "cache")
    os.makedirs(cache, exist_ok=True)
    c = lambda name: os.path.join(cache, name)
    t0 = time.time()
    if os.path.exists(c("stream.npy")):
        stream = np.load(c("stream.npy"), mmap_mode="r")
        test_streams = np.split(np.load(c("test_streams.npy")), np.cumsum(np.load(c("test_lens.npy")))[:-1])
    else:
        # Real speech: every 160 ms window of train-clean-100 for training; whole test-set files for testing.
        stream = np.concatenate([np.lib.stride_tricks.sliding_window_view(e, (16, 96))[::2, 0]
                                 for e in embed_files(libri["train"], True, 1000) if len(e) >= 16])
        test_streams = [e.astype(np.float32) for e in embed_files(libri["test"], False, 900000) if len(e) >= 16]
        np.save(c("stream.npy"), stream)
        np.save(c("test_streams.npy"), np.concatenate(test_streams))
        np.save(c("test_lens.npy"), np.array([len(e) for e in test_streams]))
    version = str(zlib.crc32(open(os.path.join(DATA, "meta.json"), "rb").read()))
    if os.path.exists(c("clip_streams.npz")) and open(c("synthetic.version")).read() == version:
        tr, te = dict(np.load(c("train.npz"))), dict(np.load(c("test.npz")))
        cs = np.load(c("clip_streams.npz"))
        pos_streams = np.split(cs["pos"], np.cumsum(cs["pos_lens"])[:-1])
        hard_streams = np.split(cs["hard"], np.cumsum(cs["hard_lens"])[:-1])
    else:
        tr = build("train", {"pos": 10, "hard": 4, "talk": 8, "bg": 20000, "early": 1800})
        te = build("test", {"pos": 4, "hard": 2, "talk": 4, "bg": 3000, "early": 400})
        pos_streams = [clip_stream(x) for x in clips["pos"]["test"] for _ in range(2)]
        hard_streams = [clip_stream(x) for x in clips["hard"]["test"] for _ in range(2)]
        np.savez(c("train.npz"), **tr)
        np.savez(c("test.npz"), **te)
        np.savez(c("clip_streams.npz"), pos=np.concatenate(pos_streams), pos_lens=[len(x) for x in pos_streams],
                 hard=np.concatenate(hard_streams), hard_lens=[len(x) for x in hard_streams])
        open(c("synthetic.version"), "w").write(version)
    print(f"synthetic windows: train {sum(len(v) for v in tr.values())}, test {sum(len(v) for v in te.values())}", flush=True)
    test_hours = sum(len(e) for e in test_streams) * 0.08 / 3600
    print(f"speech windows: train {len(stream)} ({len(stream) * 0.16 / 3600:.0f} h), test {test_hours:.1f} h "
          f"in {time.time() - t0:.0f}s", flush=True)

    class Net(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.f = torch.nn.Sequential(
                torch.nn.Flatten(), torch.nn.Linear(16 * 96, 256), torch.nn.LayerNorm(256), torch.nn.ReLU(), torch.nn.Dropout(0.3),
                torch.nn.Linear(256, 128), torch.nn.LayerNorm(128), torch.nn.ReLU(), torch.nn.Dropout(0.1), torch.nn.Linear(128, 1))

        def forward(self, x):
            return torch.sigmoid(self.f(x))

    net = Net()
    pos = torch.tensor(tr["pos"])
    neg = torch.tensor(np.concatenate([tr[k] for k in ("hard", "talk", "bg", "early")]))
    hard_neg = torch.tensor(np.concatenate([tr["hard"], tr["early"]]))

    def score(x, bs=65536):
        net.eval()
        with torch.no_grad():
            return np.concatenate([net(torch.tensor(np.asarray(x[i: i + bs], dtype=np.float32))).squeeze(1).numpy()
                                   for i in range(0, len(x), bs)])

    def sample(t, n):
        return t[torch.randint(len(t), (n,))]

    mined = torch.zeros(0, 16, 96)
    opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-3)
    rounds, steps = 4, 2500
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=1e-3, total_steps=rounds * steps, pct_start=0.1)
    bce = torch.nn.functional.binary_cross_entropy
    for r in range(rounds):
        net.train()
        neg_weight = 1.0 + 0.5 * r  # false triggers cost a little more each round
        for step in range(steps):
            xs = [sample(pos, 256), sample(neg, 192), sample(hard_neg, 64),
                  torch.tensor(stream[np.random.randint(len(stream), size=384)], dtype=torch.float32)]
            if len(mined):
                xs.append(sample(mined, 128))
            x = torch.cat(xs)
            y = torch.cat([torch.ones(256), torch.zeros(len(x) - 256)])
            w = torch.cat([torch.ones(256), torch.full((len(x) - 256,), neg_weight)])
            p = net(x).squeeze(1)
            loss = bce(p.clamp(1e-6, 1 - 1e-6), y, weight=w)
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
        s = score(stream)
        top = np.argsort(s)[::-1][: 40000]
        top = top[s[top] > 0.05]
        mined = torch.cat([mined, torch.tensor(stream[top], dtype=torch.float32)])[-120000:]
        pt = score(te["pos"])
        print(f"round {r + 1}: loss {loss.item():.4f} recall@0.5 {np.mean(pt > 0.5):.3f} "
              f"train speech >0.5: {np.mean(s > 0.5) * 100:.4f}% mined {len(mined)}", flush=True)

    # Everything is scored as a stream, one 80 ms step at a time, like the app: a wake needs `need` steps in a row
    # above the threshold, then 2 s pass before the next one.
    def triggers(s, thr, need):
        n, run, last = 0, 0, -999
        for i, v in enumerate(s):
            run = run + 1 if v > thr else 0
            if run >= need and i - last > 25:
                n, last, run = n + 1, i, 0
        return n

    stream_scores = [score(np.lib.stride_tricks.sliding_window_view(e, (16, 96))[:, 0]) for e in test_streams]
    pos_scores = [score(x) for x in pos_streams]
    hard_scores = [score(x) for x in hard_streams]
    report = {"test_hours_of_speech": round(test_hours, 2), "thresholds": []}
    for need in (1, 2, 3):
        for thr in (0.5, 0.7, 0.8, 0.9, 0.95, 0.98):
            report["thresholds"].append({
                "threshold": thr, "steps_in_a_row": need,
                "recall_heldout_voices": round(float(np.mean([triggers(s, thr, need) > 0 for s in pos_scores])), 3),
                "false_on_soundalikes": round(float(np.mean([triggers(s, thr, need) > 0 for s in hard_scores])), 4),
                "false_per_hour_real_speech": round(sum(triggers(s, thr, need) for s in stream_scores) / test_hours, 2)})
            print(report["thresholds"][-1], flush=True)

    net.eval()
    torch.onnx.export(net, torch.zeros(1, 16, 96), os.path.join(OUT, "quisk.onnx"), input_names=["embeddings"],
                      output_names=["score"], dynamic_axes={"embeddings": {0: "batch"}, "score": {0: "batch"}},
                      opset_version=13, dynamo=False)
    models = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
    for f in ("melspectrogram.onnx", "embedding_model.onnx"):
        shutil.copy(os.path.join(models, f), OUT)
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
    print("wrote", os.listdir(OUT))


if __name__ == "__main__":
    main()
