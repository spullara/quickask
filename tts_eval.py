"""tiny-voca (4.5M-parameter on-device TTS, ONNX) against Gemini 3.8 Flash-Lite TTS (production, voice Leda) on answer text.
Measures synthesis time, and intelligibility: Gemini transcribes each clip and we count word errors against the text.
Needs a Python with onnxruntime, numpy, soundfile and dizione, plus the tiny-voca weights:
  python -m venv v && v/bin/pip install onnxruntime numpy soundfile "dizione @ git+https://github.com/n4ze3m/dizione" huggingface_hub
  v/bin/hf download n4ze3m/tiny-voca --include "onnx/*" "config.json" "phonemizer/*" --local-dir WEIGHTS
Usage: DIZIONE_DATA=WEIGHTS/phonemizer v/bin/python tts_eval.py WEIGHTS OUTDIR. Writes OUTDIR/*.wav and tts_eval.json."""
import base64, io, json, os, re, ssl, statistics, sys, time, urllib.request
import numpy as np
import onnxruntime as ort
import soundfile as sf
import dizione

WEIGHTS, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
KEY = next(l.split("=", 1)[1].strip() for l in open(os.path.expanduser("~/.env")) if l.startswith("GEMINI_API_KEY="))

# Answer-style text: numbers, years, names and a longer paragraph, as /api/ask returns them for speaking.
TEXTS = [
    "The tallest mountain in the world is Mount Everest, at 8,849 meters above sea level.",
    "Jensen Huang co-founded Nvidia in 1993 and led it as chief executive until 2026.",
    "The Golden Gate Bridge opened in 1937. Its main span is about 1,280 meters long.",
    "Seventeen times twenty-three is 391.",
    "Canberra is the capital of Australia, not Sydney or Melbourne.",
    "GitHub is a platform for hosting and sharing code. Microsoft bought it in 2018 for about 7.5 billion dollars.",
    "Lisa Su was born in November 1969, so she was 23 when Nvidia was founded in April 1993. She became chief executive of AMD in 2014.",
]


def post(url, body, timeout=60):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(),
                                            {"content-type": "application/json", "x-goog-api-key": KEY}), timeout=timeout, context=CTX))


session = ort.InferenceSession(os.path.join(WEIGHTS, "onnx/model.onnx"), providers=["CPUExecutionProvider"])
one = lambda v: np.array([v], dtype=np.float32)


def tiny(text, voice):
    """Sentence by sentence (the model reads one utterance per call), joined with a short pause."""
    t0, parts = time.perf_counter(), []
    for s in re.split(r"(?<=[.!?])\s+", text.strip()):
        p = dizione.phonemize(s)
        audio, _ = session.run(None, {"tokens": np.array([p.ids], dtype=np.int64), "stress": np.array([p.stress], dtype=np.int64),
                                      "voice": np.array([voice], dtype=np.int64), "speed": one(1.0), "pitch_shift": one(0.0), "pitch_range": one(1.0)})
        parts += [audio[0], np.zeros(int(24000 * 0.25), dtype=np.float32)]
    wav = np.concatenate(parts)
    return time.perf_counter() - t0, wav, 24000


def gemini_tts(text):
    t0 = time.perf_counter()
    d = post("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent",
             {"contents": [{"parts": [{"text": text}]}], "generationConfig": {"responseModalities": ["AUDIO"],
              "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Leda"}}}}})
    took = time.perf_counter() - t0
    data = base64.b64decode(d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
    wav, rate = sf.read(io.BytesIO(data)) if data[:4] == b"RIFF" else (np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768, 24000)
    return took, wav, rate


def transcribe(path):
    audio = base64.b64encode(open(path, "rb").read()).decode()
    d = post("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
             {"contents": [{"parts": [{"inlineData": {"mimeType": "audio/wav", "data": audio}},
                                      {"text": "Transcribe this speech exactly, word for word. Write numbers as digits. Output only the transcript."}]}],
              "generationConfig": {"temperature": 0}})
    return d["candidates"][0]["content"]["parts"][0]["text"].strip()


SPOKEN = {"seventeen": "17", "twentythree": "23"}


def words(s):
    s = s.lower().replace("-", "").replace(",", "")
    return [SPOKEN.get(w, w) for w in re.findall(r"[a-z0-9.]+", s.replace(". ", " ").rstrip("."))]


def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
    return d[len(h)] / max(1, len(r))


SYSTEMS = {"tiny-voca F2": lambda t: tiny(t, 0), "tiny-voca M2": lambda t: tiny(t, 1), "gemini Leda": gemini_tts}
tiny(TEXTS[0], 0)  # warm up the ONNX session
rows = []
for i, text in enumerate(TEXTS):
    for name, synth in SYSTEMS.items():
        took, wav, rate = synth(text)
        path = os.path.join(OUT, f"{i+1}-{name.replace(' ', '-')}.wav")
        sf.write(path, wav, rate, subtype="PCM_16")
        seconds = len(wav) / rate
        heard = transcribe(path)
        rows.append({"text": i + 1, "system": name, "synth_s": round(took, 3), "audio_s": round(seconds, 2),
                     "x_realtime": round(seconds / took, 1), "wer": round(wer(text, heard), 3), "heard": heard})
        print(f"{i+1} {name:13} {took:6.2f}s for {seconds:5.1f}s audio  WER {rows[-1]['wer']:.2f}  | {heard[:90]}", flush=True)

summary = []
for name in SYSTEMS:
    r = [x for x in rows if x["system"] == name]
    summary.append({"system": name, "synth_p50_s": round(statistics.median(x["synth_s"] for x in r), 3),
                    "x_realtime_p50": round(statistics.median(x["x_realtime"] for x in r), 1),
                    "mean_wer": round(statistics.mean(x["wer"] for x in r), 3), "perfect": f"{sum(x['wer'] == 0 for x in r)}/{len(r)}"})
json.dump({"summary": summary, "rows": rows, "texts": TEXTS}, open("tts_eval.json", "w"), indent=1)
print()
for s in summary:
    print(f"{s['system']:13} synth p50 {s['synth_p50_s']:6.3f}s  {s['x_realtime_p50']:6.1f}x real time  mean WER {s['mean_wer']:.3f}  exact {s['perfect']}")
