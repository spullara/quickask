// Quisk's voice, in a background worker: text to phonemes with dizione (Python, through Pyodide) and, on the web,
// phonemes to speech with tiny-voca (ONNX Runtime Web). Everything is downloaded once and cached; the phone apps use
// only the phonemizer here and make the audio with the voice built into the app.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.28.3/full/";
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/";
const MODEL = "https://huggingface.co/n4ze3m/tiny-voca/resolve/main/onnx/model.onnx";
const WHEEL = "/voice/dizione-1.whl"; // dizione with its lexicon and g2p data; rename to change the cached copy

async function cached(url) {
  try {
    const cache = await caches.open("quisk-voice-1");
    let res = await cache.match(url);
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error(url + " " + res.status);
      await cache.put(url, res.clone());
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(url + " " + res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
}

let phonemizerP = null, modelP = null;

function phonemizer() {
  return phonemizerP ??= (async () => {
    importScripts(PYODIDE + "pyodide.js");
    const py = await loadPyodide({ indexURL: PYODIDE });
    await py.loadPackage("numpy");
    py.unpackArchive((await cached(WHEEL)).buffer, "zip", { extractDir: "/voice" });
    py.runPython(`
import json, sys
sys.path.insert(0, "/voice")
import dizione

def phonemize_all(sentences_json):
    out = []
    for s in json.loads(sentences_json):
        try:
            p = dizione.phonemize(s) if s.strip() else None
        except Exception:
            p = None
        out.append({"ids": list(p.ids), "stress": list(p.stress)} if p else None)
    return json.dumps(out)

phonemize_all('["Ready."]')
`);
    const fn = py.globals.get("phonemize_all");
    postMessage({ ready: "phonemes" });
    return fn;
  })();
}

function model() {
  return modelP ??= (async () => {
    importScripts(ORT + "ort.wasm.min.js");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = ORT;
    const session = await ort.InferenceSession.create(await cached(MODEL), { executionProviders: ["wasm"] });
    postMessage({ ready: "model" });
    return session;
  })();
}

const i64 = (a) => new ort.Tensor("int64", BigInt64Array.from(a.map((x) => BigInt(x))), [1, a.length]);
const f32 = (x) => new ort.Tensor("float32", Float32Array.of(x), [1]);

onmessage = async (e) => {
  const m = e.data;
  if (m.op === "init") {
    phonemizer().catch(() => { phonemizerP = null; });
    if (m.model) model().catch(() => { modelP = null; });
    return;
  }
  try {
    if (m.op === "phonemize") {
      const fn = await phonemizer();
      postMessage({ id: m.id, ok: true, result: JSON.parse(fn(JSON.stringify(m.sentences))) });
    } else if (m.op === "synth") {
      const session = await model();
      const parts = [];
      for (const p of m.ph) {
        const ids = p.ids.slice(0, 512), stress = p.stress.slice(0, 512);
        const out = await session.run({
          tokens: i64(ids), stress: i64(stress), voice: new ort.Tensor("int64", BigInt64Array.of(BigInt(m.voice)), [1]),
          speed: f32(1), pitch_shift: f32(0), pitch_range: f32(1),
        });
        parts.push(out.audio.data, new Float32Array(6000));
      }
      const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.length; }
      postMessage({ id: m.id, ok: true, result: all }, [all.buffer]);
    }
  } catch (err) {
    postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
