"""Make synthetic training audio for the "Quisk" wake word: positives ("Quisk", "Hey Quisk", ...), hard negatives
(sound-alikes: quick, whisk, kiosk, ...) and ordinary sentences, from three voice sources:
  - Gemini 3.8 Flash-Lite TTS with its English library voices (about 660 voices, 7 accents)
  - the macOS voices (say)
  - tiny-voca F2/M2 at several speeds and pitches
  - Piper's LibriTTS-R voice (904 speakers, CC BY 4.0) at several speeds and amounts of variation
Writes 16 kHz mono WAVs to OUT/{pos,hard,talk}/, a list per source (OUT/meta-<source>.json: voice, text, split) and
all of them in OUT/meta.json. About 15% of the Gemini and Piper speakers and 20% of the macOS voices are held out for
testing ("test" split). A source whose list already exists is skipped, so new sources can be added later.
Usage: python generate.py OUT [TINY_VOCA_WEIGHTS] [PIPER_MODEL.onnx]   (GEMINI_API_KEY from ~/.env)"""
import base64, glob, io, json, os, random, re, ssl, subprocess, sys, tempfile, time, urllib.error, urllib.request, zlib
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

OUT = sys.argv[1]
TV = sys.argv[2] if len(sys.argv) > 2 else None
PIPER = sys.argv[3] if len(sys.argv) > 3 else None
random.seed(7)
for d in ("pos", "hard", "talk"):
    os.makedirs(os.path.join(OUT, d), exist_ok=True)
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
KEY = next(l.split("=", 1)[1].strip() for l in open(os.path.expanduser("~/.env")) if l.startswith("GEMINI_API_KEY="))

POS = ["Quisk.", "Quisk!", "Quisk?", "Hey Quisk.", "Okay Quisk.", "Hi Quisk."]
HARD = ["quick", "quiz", "whisk", "risk", "disk", "kiosk", "brisk", "frisk", "quest", "quit", "quilt", "quiche", "squish",
        "squeak", "kiss", "ask", "task", "mask", "bisque", "tusk", "husk", "dusk", "whiskey", "quickly", "biscuit",
        "Christ", "Swiss", "Quixote", "risky", "frisky", "cuisine", "Quinn", "quid", "quip", "wisp", "whisper", "Kwik-E-Mart",
        "quick step", "hey quick", "okay quiz", "hey whisk", "Wisconsin", "asterisk", "obelisk", "basilisk", "tamarisk"]
TALK = ["The meeting moved to three o'clock on Thursday.", "Can you pick up some milk on the way home?",
        "I think the quick brown fox jumped over the lazy dog.", "Turn left at the next light and keep going straight.",
        "What time does the store close tonight?", "She asked whether the kiosk at the station sells tickets.",
        "We should whisk the eggs before adding the flour.", "Is it risky to leave the disk drive running all night?",
        "Let's take a quick break and come back in ten minutes.", "The quiz show starts right after the evening news.",
        "Hey, can you hear me? I'm calling from the car.", "Okay, so the plan is to leave at dawn and arrive by noon."]
meta = []
tag = lambda text: zlib.crc32(text.encode()) % 100000
safe = lambda name: re.sub(r"[^A-Za-z0-9._-]+", "_", name)


def stage(name):
    """True when the source still has to be made; else its saved list is loaded."""
    path = os.path.join(OUT, f"meta-{name}.json")
    if os.path.exists(path):
        meta.extend(json.load(open(path)))
        print(f"{name}: kept {len(json.load(open(path)))} clips", flush=True)
        return False
    for f in glob.glob(os.path.join(OUT, "*", f"{name}-*.wav")):
        os.remove(f)
    return True


def done(name):
    json.dump([m for m in meta if m["path"].split(os.sep)[-1].startswith(name + "-")], open(os.path.join(OUT, f"meta-{name}.json"), "w"), indent=0)


def save(kind, name, audio, rate, **info):
    if rate != 16000:
        audio = resample_poly(audio, 16000, rate)
    audio = np.asarray(audio, dtype=np.float32)
    peak = np.abs(audio).max() or 1.0
    path = os.path.join(kind, safe(name) + ".wav")
    sf.write(os.path.join(OUT, path), (audio / peak * 0.9 * 32767).astype(np.int16), 16000, subtype="PCM_16")
    meta.append({"path": path, "kind": kind, **info})


# --- Gemini TTS -----------------------------------------------------------------------------------------------------
def gemini(text, voice):
    body = {"contents": [{"parts": [{"text": text}]}], "generationConfig": {"responseModalities": ["AUDIO"],
            "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}
    for attempt in range(5):
        try:
            d = json.load(urllib.request.urlopen(urllib.request.Request(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-lite-tts:generateContent",
                json.dumps(body).encode(), {"content-type": "application/json", "x-goog-api-key": KEY}), context=CTX, timeout=60))
            data = base64.b64decode(d["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
            return sf.read(io.BytesIO(data), dtype="float32")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503):
                time.sleep(2 ** attempt)
                continue
            return None
        except Exception:
            time.sleep(1)
    return None


def make_gemini():
    voices = [v for v in json.load(urllib.request.urlopen(urllib.request.Request(
        "https://generativelanguage.googleapis.com/v1beta/voices?pageSize=1000", headers={"x-goog-api-key": KEY}), context=CTX))["voices"]
        if str(v.get("language_code", "")).startswith("en")]
    random.shuffle(voices)
    held = {v["id"] for v in voices[: len(voices) * 15 // 100]}
    jobs = []
    for i, v in enumerate(voices):
        split = "test" if v["id"] in held else "train"
        jobs.append(("pos", POS[i % len(POS)], v, split))
        jobs.append(("pos", POS[(i + 3) % len(POS)], v, split))
        if i % 2 == 0:
            jobs.append(("hard", ", ".join(random.sample(HARD, 8)) + ".", v, split))
        if i % 4 == 0:
            jobs.append(("talk", random.choice(TALK), v, split))

    def run(job):
        kind, text, v, split = job
        got = gemini(text, v["id"])
        if got:
            save(kind, f"gemini-{v['id']}-{kind}-{tag(text)}", got[0], got[1], source="gemini", voice=v["id"],
                 accent=v.get("accent"), gender=v.get("gender"), text=text, split=split)
        return got is not None

    t0 = time.time()
    with ThreadPoolExecutor(16) as ex:
        ok = sum(ex.map(run, jobs))
    print(f"gemini: {ok}/{len(jobs)} clips in {time.time() - t0:.0f}s", flush=True)


# --- macOS voices ---------------------------------------------------------------------------------------------------
def make_mac():
    mac = [l.split()[0] for l in subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout.splitlines()
           if re.search(r"\ben_(US|GB|AU|IE|IN|ZA|SC|NZ)\b", l) and not l.startswith(("Bad", "Bells", "Boing", "Bubbles", "Cellos", "Good", "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Bahh", "Albert"))]
    random.shuffle(mac)
    held = set(mac[: len(mac) // 5])

    def say(job):
        kind, text, voice, rate = job
        with tempfile.NamedTemporaryFile(suffix=".wav") as f:
            r = subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", f.name, "--file-format=WAVE", "--data-format=LEI16@16000", text],
                               capture_output=True)
            if r.returncode:
                return False
            audio, sr = sf.read(f.name, dtype="float32")
        save(kind, f"mac-{voice}-{rate}-{kind}-{tag(text)}", audio, sr, source="mac", voice=voice, text=text,
             split="test" if voice in held else "train")
        return True

    jobs = []
    for voice in mac:
        for rate in (150, 180, 220):
            jobs += [("pos", t, voice, rate) for t in POS]
        jobs += [("hard", w, voice, random.choice((160, 190, 220))) for w in HARD]
        jobs += [("talk", t, voice, 185) for t in random.sample(TALK, 4)]
    with ThreadPoolExecutor(8) as ex:
        ok = sum(ex.map(say, jobs))
    print(f"mac: {ok}/{len(jobs)} clips from {len(mac)} voices", flush=True)


# --- tiny-voca --------------------------------------------------------------------------------------------------------
def make_tv():
    os.environ.setdefault("DIZIONE_DATA", os.path.join(TV, "phonemizer"))
    import dizione
    import onnxruntime as ort
    sess = ort.InferenceSession(os.path.join(TV, "onnx/model.onnx"), providers=["CPUExecutionProvider"])
    one = lambda x: np.array([x], dtype=np.float32)
    n = 0
    for voice in (0, 1):
        for speed in (0.8, 0.9, 1.0, 1.12, 1.25):
            for pitch in (-0.15, 0.0, 0.15):
                for kind, texts in (("pos", POS), ("hard", random.sample(HARD, 12))):
                    for text in texts:
                        p = dizione.phonemize(text)
                        audio, _ = sess.run(None, {"tokens": np.array([p.ids], dtype=np.int64), "stress": np.array([p.stress], dtype=np.int64),
                                                   "voice": np.array([voice], dtype=np.int64), "speed": one(speed), "pitch_shift": one(pitch), "pitch_range": one(1.0)})
                        save(kind, f"tv-{voice}-{speed}-{pitch}-{kind}-{tag(text)}", audio[0], 24000, source="tiny-voca",
                             voice=f"tv{voice}", text=text, split="train")
                        n += 1
    print(f"tiny-voca: {n} clips", flush=True)


# --- Piper LibriTTS-R (904 speakers) ----------------------------------------------------------------------------------
def make_piper():
    from piper import PiperVoice, SynthesisConfig
    voice = PiperVoice.load(PIPER)
    speakers = list(range(voice.config.num_speakers))
    random.shuffle(speakers)
    held = set(speakers[: len(speakers) * 15 // 100])
    jobs = []
    for sid in speakers:
        split = "test" if sid in held else "train"
        for i in range(6):
            jobs.append(("pos", random.choice(POS), sid, split, random.uniform(0.75, 1.35), random.uniform(0.4, 1.0)))
        for w in random.sample(HARD, 6):
            jobs.append(("hard", w, sid, split, random.uniform(0.8, 1.3), random.uniform(0.4, 1.0)))
        jobs.append(("talk", random.choice(TALK), sid, split, random.uniform(0.85, 1.2), 0.667))

    def run(job):
        kind, text, sid, split, length, noise = job
        cfg = SynthesisConfig(speaker_id=sid, length_scale=length, noise_scale=noise, noise_w_scale=random.uniform(0.5, 1.0))
        audio = np.concatenate([c.audio_float_array for c in voice.synthesize(text, syn_config=cfg)])
        save(kind, f"piper-{sid}-{kind}-{length:.2f}-{noise:.2f}-{tag(text)}", audio, voice.config.sample_rate, source="piper",
             voice=f"piper{sid}", text=text, split=split)

    t0 = time.time()
    for job in jobs:  # one at a time: Piper's phonemizer (eSpeak NG) is not thread-safe
        run(job)
    print(f"piper: {len(jobs)} clips from {len(speakers)} speakers in {time.time() - t0:.0f}s", flush=True)


for name, make, ready in (("gemini", make_gemini, True), ("mac", make_mac, True), ("tv", make_tv, bool(TV)), ("piper", make_piper, bool(PIPER))):
    if ready and stage(name):
        make()
        done(name)
json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), indent=0)
from collections import Counter
print(Counter((m["kind"], m["split"]) for m in meta))
