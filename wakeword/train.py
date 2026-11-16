"""Train the "Quisk" wake-word classifier on openWakeWord features (frozen mel spectrogram + Google speech embedding).
Each example is a 2.0 s window (16 embedding frames x 96). Positives end at the end of the window, so the detector
fires as the word ends. Writes OUT/quisk.onnx, OUT/report.json, and copies the two feature models next to it.
Usage: python train.py DATA LIBRISPEECH_DIR OUT"""
import glob, json, os, random, shutil, sys, time
import numpy as np
import soundfile as sf
import torch
from scipy.signal import fftconvolve, resample_poly
import openwakeword
from openwakeword.utils import AudioFeatures

DATA, LIBRI, OUT = sys.argv[1:4]
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(11)
random.seed(11)
torch.manual_seed(11)
SR, L = 16000, 32000
feat = AudioFeatures(inference_framework="onnx", ncpu=os.cpu_count() or 4)

meta = json.load(open(os.path.join(DATA, "meta.json")))
load = lambda p: sf.read(os.path.join(DATA, p), dtype="float32")[0]


def trim(x, thr=0.02):
    on = np.where(np.abs(x) > thr * np.abs(x).max())[0]
    return x[max(0, on[0] - 800): on[-1] + 800] if len(on) else x


clips = {k: {"train": [], "test": []} for k in ("pos", "hard", "talk")}
for m in meta:
    clips[m["kind"]][m["split"]].append(trim(load(m["path"])))
print({k: {s: len(v) for s, v in d.items()} for k, d in clips.items()}, flush=True)

# LibriSpeech, split by speaker so test speech comes from people never heard in training.
speakers = sorted(os.listdir(glob.glob(os.path.join(LIBRI, "**", "dev-clean"), recursive=True)[0]))
random.shuffle(speakers)
test_speakers = set(speakers[: len(speakers) // 5])
libri = {"train": [], "test": []}
for f in glob.glob(os.path.join(LIBRI, "**", "*.flac"), recursive=True):
    spk = f.split(os.sep)[-3]
    libri["test" if spk in test_speakers else "train"].append(f)
libri_audio = {s: [sf.read(f, dtype="float32")[0] for f in fs] for s, fs in libri.items()}
print({s: f"{sum(len(a) for a in v) / SR / 3600:.2f} h" for s, v in libri_audio.items()}, flush=True)


def noise(n):
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


def speech_bg(split, n):
    a = libri_audio[split][rng.integers(len(libri_audio[split]))]
    if len(a) < n:
        a = np.tile(a, n // len(a) + 1)
    s = rng.integers(0, len(a) - n + 1)
    return a[s: s + n]


def background(split, n=L):
    r = rng.random()
    if r < 0.45:
        bg = speech_bg(split, n) * 10 ** (rng.uniform(-30, -6) / 20)
    elif r < 0.75:
        bg = noise(n) * 10 ** (rng.uniform(-45, -15) / 20)
    else:
        bg = noise(n) * 10 ** (-60 / 20)
    if rng.random() < 0.3:
        bg = bg + noise(n) * 10 ** (rng.uniform(-50, -25) / 20)
    return bg.astype(np.float32)


def reverb(x):
    rt60 = rng.uniform(0.15, 0.8)
    n = int(rt60 * SR)
    ir = rng.standard_normal(n).astype(np.float32) * np.exp(-6.9 * np.arange(n) / n).astype(np.float32)
    ir[0] = 1.0
    y = fftconvolve(x, ir)[: len(x) + n // 2]
    return y / (np.abs(y).max() + 1e-9) * np.abs(x).max()


def augment(x):
    if rng.random() < 0.7:
        f = rng.uniform(0.88, 1.12)
        x = resample_poly(x, 100, int(round(100 * f))).astype(np.float32)
    if rng.random() < 0.5:
        x = reverb(x)
    return x * rng.uniform(0.3, 1.0)


def window(clip, split, end_aligned=True):
    """A 2.0 s window with the clip inside: ending 0-240 ms before the window's end, or anywhere (negatives)."""
    bg = background(split)
    if clip is not None:
        x = augment(clip)
        x = x[-(L - 1600):] if len(x) > L - 1600 else x
        end = L - int(rng.uniform(0, 0.24) * SR) if end_aligned else int(rng.uniform(len(x), L))
        snr = rng.uniform(0, 25)
        level = np.sqrt(np.mean(x ** 2)) + 1e-9
        bgl = np.sqrt(np.mean(bg ** 2)) + 1e-9
        if bgl > 1e-4:
            bg = bg * (level / bgl) * 10 ** (-snr / 20)
        bg[end - len(x): end] += x
    peak = np.abs(bg).max() + 1e-9
    bg = bg / peak * rng.uniform(0.05, 0.9)
    return (np.clip(bg, -1, 1) * 32767).astype(np.int16)


def embed(windows):
    out = []
    for i in range(0, len(windows), 512):
        out.append(feat.embed_clips(np.stack(windows[i: i + 512]), batch_size=256))
    return np.concatenate(out).astype(np.float32)


def build(split, scale):
    X, y = [], []
    pos = [window(c, split) for c in clips["pos"][split] for _ in range(scale["pos"])]
    hard = [window(c, split, end_aligned=rng.random() < 0.7) for c in clips["hard"][split] for _ in range(scale["hard"])]
    talk = [window(c, split, end_aligned=rng.random() < 0.5) for c in clips["talk"][split] for _ in range(scale["talk"])]
    bg = [window(None, split) for _ in range(scale["bg"])]
    # Near misses: "Quisk" cut off or still in progress at the window's end must not fire.
    early = []
    for c in random.sample(clips["pos"][split], min(len(clips["pos"][split]), scale["early"])):
        cut = c[: int(len(c) * rng.uniform(0.3, 0.6))]
        early.append(window(cut, split))
    for group, label in ((pos, 1), (hard, 0), (talk, 0), (bg, 0), (early, 0)):
        if group:
            X.append(embed(group)); y += [label] * len(group)
    return np.concatenate(X), np.array(y, dtype=np.float32)


t0 = time.time()
Xtr, ytr = build("train", {"pos": 8, "hard": 3, "talk": 6, "bg": 60000, "early": 1500})
Xte, yte = build("test", {"pos": 4, "hard": 2, "talk": 4, "bg": 4000, "early": 300})
print(f"features: train {Xtr.shape} ({int(ytr.sum())} positive), test {Xte.shape} in {time.time() - t0:.0f}s", flush=True)


class Net(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.f = torch.nn.Sequential(
            torch.nn.Flatten(), torch.nn.Linear(16 * 96, 128), torch.nn.LayerNorm(128), torch.nn.ReLU(), torch.nn.Dropout(0.2),
            torch.nn.Linear(128, 128), torch.nn.LayerNorm(128), torch.nn.ReLU(), torch.nn.Linear(128, 1))

    def forward(self, x):
        return torch.sigmoid(self.f(x))


net = Net()
opt = torch.optim.AdamW(net.parameters(), lr=1e-3, weight_decay=1e-3)
Xt, yt = torch.tensor(Xtr), torch.tensor(ytr)
w = torch.where(yt == 1, torch.tensor(float((ytr == 0).sum() / max(1, ytr.sum())) ** 0.5), torch.tensor(1.0))
for epoch in range(30):
    net.train()
    perm = torch.randperm(len(Xt))
    for i in range(0, len(perm), 512):
        idx = perm[i: i + 512]
        p = net(Xt[idx]).squeeze(1)
        loss = torch.nn.functional.binary_cross_entropy(p.clamp(1e-6, 1 - 1e-6), yt[idx], weight=w[idx])
        opt.zero_grad(); loss.backward(); opt.step()
    if epoch % 5 == 4:
        net.eval()
        with torch.no_grad():
            pt = net(torch.tensor(Xte)).squeeze(1).numpy()
        print(f"epoch {epoch + 1}: loss {loss.item():.4f} test recall@0.5 {np.mean(pt[yte == 1] > 0.5):.3f} "
              f"false@0.5 {np.mean(pt[yte == 0] > 0.5):.4f}", flush=True)

net.eval()
with torch.no_grad():
    pt = net(torch.tensor(Xte)).squeeze(1).numpy()


# False triggers per hour of held-out real speech, streamed frame by frame (one decision per 80 ms, 2 s refractory).
def stream_scores(audio):
    e = feat._get_embeddings((np.clip(audio, -1, 1) * 32767).astype(np.int16)).astype(np.float32)
    wins = np.stack([e[i - 16: i] for i in range(16, len(e) + 1)])
    with torch.no_grad():
        return net(torch.tensor(wins)).squeeze(1).numpy()


test_speech = np.concatenate(libri_audio["test"])
hours = len(test_speech) / SR / 3600
scores = np.concatenate([stream_scores(test_speech[i: i + SR * 300]) for i in range(0, len(test_speech), SR * 300)])


def triggers(s, thr):
    n, last = 0, -999
    for i, v in enumerate(s):
        if v > thr and i - last > 25:
            n, last = n + 1, i
    return n


report = {"test_hours_of_speech": round(hours, 2), "thresholds": []}
for thr in (0.3, 0.5, 0.7, 0.8, 0.9, 0.95):
    hard_idx = slice(int((yte == 1).sum()), int((yte == 1).sum()) + len(clips["hard"]["test"]) * 2)
    report["thresholds"].append({
        "threshold": thr, "recall_heldout_voices": round(float(np.mean(pt[yte == 1] > thr)), 3),
        "false_on_soundalikes": round(float(np.mean(pt[hard_idx] > thr)), 4),
        "false_per_hour_real_speech": round(triggers(scores, thr) / hours, 2)})
    print(report["thresholds"][-1], flush=True)

torch.onnx.export(net, torch.zeros(1, 16, 96), os.path.join(OUT, "quisk.onnx"), input_names=["embeddings"], output_names=["score"],
                  dynamic_axes={"embeddings": {0: "batch"}, "score": {0: "batch"}}, opset_version=13)
models = os.path.join(os.path.dirname(openwakeword.__file__), "resources", "models")
for f in ("melspectrogram.onnx", "embedding_model.onnx"):
    shutil.copy(os.path.join(models, f), OUT)
json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
print("wrote", os.listdir(OUT))
