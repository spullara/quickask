"""Live test of the "Quisk" wake word on this Mac's microphone. The same streaming steps as ios/Quisk/WakeWord.swift:
1280 samples (80 ms) at a time, mel frames with 480 samples of context, 76 mel frames per embedding, 16 embeddings
per score. Prints a score bar every 80 ms and "QUISK" on a wake.
Usage: python listen.py MODELS_DIR [THRESHOLD] [STEPS_IN_A_ROW]"""
import os, queue, sys, time
import numpy as np
import onnxruntime as ort
import sounddevice as sd

DIR = sys.argv[1]
THR = float(sys.argv[2]) if len(sys.argv) > 2 else 0.8
NEED = int(sys.argv[3]) if len(sys.argv) > 3 else 1
opts = ort.SessionOptions()
opts.intra_op_num_threads = 1
load = lambda name: ort.InferenceSession(os.path.join(DIR, name + ".onnx"), opts, providers=["CPUExecutionProvider"])
mel, embed, classify = load("melspectrogram"), load("embedding_model"), load("quisk")

audio = queue.Queue()
pending, tail, frames, feats = np.zeros(0, np.float32), np.zeros(0, np.float32), [], []
run, last = 0, 0.0


def callback(data, n, t, status):
    audio.put(data[:, 0].copy())


print(f"Listening (threshold {THR}, {NEED} step(s) in a row). Say \"Quisk\". Ctrl-C to stop.", flush=True)
with sd.InputStream(samplerate=16000, channels=1, dtype="float32", blocksize=1280, callback=callback):
    while True:
        pending = np.concatenate([pending, audio.get() * 32767])
        while len(pending) >= 1280:
            chunk, pending = pending[:1280], pending[1280:]
            window = np.concatenate([tail, chunk])
            tail = window[-480:]
            m = mel.run(["output"], {"input": window[None].astype(np.float32)})[0].reshape(-1, 32)
            frames += list(m / 10 + 2)
            frames = frames[-120:]
            if len(frames) < 76:
                continue
            e = embed.run(["conv2d_19"], {"input_1": np.array(frames[-76:], np.float32).reshape(1, 76, 32, 1)})[0].reshape(96)
            feats = (feats + [e])[-16:]
            if len(feats) < 16:
                continue
            s = float(classify.run(["score"], {"embeddings": np.array(feats, np.float32)[None]})[0].reshape(-1)[0])
            run = run + 1 if s > THR else 0
            woke = run >= NEED and time.time() - last > 2
            if woke:
                last, run = time.time(), 0
            level = 20 * np.log10(np.sqrt(np.mean(chunk ** 2)) / 32767 + 1e-9)
            bar = "#" * int(s * 40)
            print(f"\r{s:5.2f} |{bar:<40}| {level:6.1f} dB {'  QUISK!' if woke else '        '}", end="\n" if woke else "", flush=True)
