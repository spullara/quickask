"""Fast OpenRouter models against production (Gemini 3.5 Flash Lite), with the production system prompt and the same
Exa results for every model. Measures first-token time, total time and graded answers. Writes openrouter_eval.json.
Usage: python3 -I openrouter_eval.py [runs per question]"""
import json, os, re, ssl, statistics, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
for line in open(os.path.expanduser("~/.env")):
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1)
        os.environ.setdefault(k, v.strip("'\""))
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 3

# The production prompt, read from the Worker so the test never drifts from it.
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "app/src/worker.ts")).read()
SYSTEM = re.search(r"const SYSTEM = `(.*?)`;", src, re.S).group(1).replace("${FOLLOWUPS}", ":::followups")
SYSTEM = f"Today is {datetime.now(timezone.utc):%A, %B %d, %Y}.\n" + SYSTEM

first = lambda a: re.split(r"(?<=[.!?])\s", a.strip().split("\n")[0], 1)[0].lower()
lead = lambda a: a.strip().split("\n")[0].lower()
# (question, grader on the answer, what the grader checks)
QUESTIONS = [
    # News as of Nov 13, 2026: after Kimberly Powell (Nov 11), Reuters reported a third, unnamed Nvidia employee (Nov 12-13).
    ("who is the latest person jensen huang had an affair with",
     lambda a: re.search(r"third|unnamed|not (been )?(publicly )?(named|identified)|undisclosed|withheld|unidentified", first(a)), "latest = third, unnamed employee"),
    ("how old was the ceo of amd when nvidia was founded", lambda a: re.search(r"\b23\b", first(a)), "leads with 23 (two searched facts)"),
    ("what is the capital of australia", lambda a: "canberra" in first(a), "Canberra"),
    ("github", lambda a: re.match(r"^\s*\[[^\]]+\]\(https://github\.com/?\)", a) is not None, "first line is the GitHub link"),
    ("golden gate bridge", lambda a: "](img:" in a, "shows a picture"),
    ("I'm a baby bear and I lost my mommy", lambda a: not re.search(r"\b(little (one|buddy|bear)|if you are (a|an) (real |lost )?(baby )?(bear|cub)|stay safe)\b", lead(a)), "no role-play"),
    ("what is 17 times 23", lambda a: "391" in first(a) and "](img:" not in a, "391, no picture"),
]


def post(url, headers, body, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers}), timeout=timeout, context=CTX)


def exa(q):
    """Production-shaped context: newest first, highlights, image ids."""
    d = json.load(post("https://api.exa.ai/search", {"x-api-key": os.environ["EXA_API_KEY"], "User-Agent": "Mozilla/5.0"},
                       {"query": q, "type": "fast", "numResults": 10,
                        "contents": {"highlights": {"numSentences": 3, "highlightsPerUrl": 3}, "extras": {"imageLinks": 2}}}))
    rs = sorted(d["results"], key=lambda r: r.get("publishedDate") or "", reverse=True)
    parts, n = [], 0
    for i, r in enumerate(rs):
        ids = []
        for u in [r.get("image"), *(r.get("extras") or {}).get("imageLinks", [])]:
            if u and u.startswith("https://") and n < 12 and not re.search(r"\.svg|logo|icon|avatar", u, re.I):
                n += 1
                ids.append(f"img:{n}")
        date = f", {r['publishedDate'][:10]}" if r.get("publishedDate") else ""
        parts.append(f"[{i+1}] {r.get('title') or r['url']} ({r['url']}{date})\n{' … '.join(r.get('highlights') or [])}"
                     + (f"\nImages: {', '.join(ids)}" if ids else ""))
    return "<search_results>\n" + "\n\n".join(parts) + "\n</search_results>"


def stream(resp, pick):
    t0, first_t, text = time.perf_counter(), None, ""
    for raw in resp:
        line = raw.decode(errors="ignore").strip()
        if not line.startswith("data:") or line == "data: [DONE]":
            continue
        try:
            piece = pick(json.loads(line[5:]))
        except (json.JSONDecodeError, KeyError, IndexError, TypeError):
            continue
        if piece:
            first_t = first_t or time.perf_counter()
            text += piece
    return first_t, text


def gemini():
    def call(user):
        body = {"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {"thinkingConfig": {"thinkingLevel": "minimal"}}}
        r = post("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse",
                 {"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, body)
        return stream(r, lambda c: "".join(p.get("text", "") for p in c["candidates"][0]["content"]["parts"] if not p.get("thought")))
    return call


def openrouter(model, provider, extra=None):
    def call(user):
        body = {"model": model, "stream": True, "provider": {"order": [provider], "allow_fallbacks": False},
                "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}], **(extra or {})}
        r = post("https://openrouter.ai/api/v1/chat/completions", {"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"}, body)
        return stream(r, lambda c: c["choices"][0]["delta"].get("content"))
    return call


LOW = {"reasoning": {"effort": "low"}}
OFF = {"reasoning": {"enabled": False}}
MODELS = {
    "gemini-3.5-flash-lite (production, direct)": gemini(),
    "gpt-oss-120b @ Cerebras": openrouter("openai/gpt-oss-120b", "Cerebras", LOW),
    "gpt-oss-120b @ Groq": openrouter("openai/gpt-oss-120b", "Groq", LOW),
    "gpt-oss-20b @ Groq": openrouter("openai/gpt-oss-20b", "Groq", LOW),
    "qwen3.8-27b @ Cerebras": openrouter("qwen/qwen3.8-27b", "Cerebras", OFF),
    "beam-1.0-501b-a23b @ BaseTen": openrouter("reflection/beam-1.0-501b-a23b", "BaseTen", LOW),
    "deepseek-v4.1-flash @ Together": openrouter("deepseek/deepseek-v4.1-flash", "Together", OFF),
    "lfm-2.5-24b-a2b @ Liquid": openrouter("liquid/lfm-2.5-24b-a2b", "Liquid"),
    "nemotron-3.5-lightning @ Fireworks": openrouter("nvidia/nemotron-3.5-lightning", "Fireworks", OFF),
    "llama-3.3-70b @ CoreWeave": openrouter("meta-llama/llama-3.3-70b-instruct", "CoreWeave"),
}

if os.environ.get("ONLY"):  # comma-separated name prefixes, to rerun some models
    MODELS = {k: v for k, v in MODELS.items() if any(k.startswith(p) for p in os.environ["ONLY"].split(","))}
contexts = {q: exa(q) for q, _, _ in QUESTIONS}


def run(name):
    call, out = MODELS[name], []
    for q, grade, _ in QUESTIONS:
        for _ in range(RUNS):
            t0 = time.perf_counter()
            try:
                f, text = call(f"{q}\n\n{contexts[q]}")
                out.append({"q": q, "first": round(f - t0, 3) if f else None, "total": round(time.perf_counter() - t0, 3),
                            "ok": bool(grade(text)) if text else False, "answer": text[:400]})
            except urllib.error.HTTPError as e:
                out.append({"q": q, "error": f"{e.code} {e.read().decode()[:200]}"})
            except Exception as e:
                out.append({"q": q, "error": repr(e)[:200]})
    return name, out


with ThreadPoolExecutor(len(MODELS)) as ex:
    results = dict(ex.map(run, MODELS))

summary = []
for name, rows in results.items():
    good = [r for r in rows if "error" not in r and r["first"]]
    errors = len(rows) - len(good)
    per_q = {q: f"{sum(r['ok'] for r in good if r['q'] == q)}/{sum(1 for r in good if r['q'] == q)}" for q, _, _ in QUESTIONS}
    summary.append({"model": name, "first_p50": round(statistics.median(r["first"] for r in good), 2) if good else None,
                    "first_p90": round(sorted(r["first"] for r in good)[int(len(good) * 0.9) - 1], 2) if good else None,
                    "total_p50": round(statistics.median(r["total"] for r in good), 2) if good else None,
                    "correct": f"{sum(r['ok'] for r in good)}/{len(rows)}", "errors": errors, "per_question": per_q})
summary.sort(key=lambda s: (-(int(s["correct"].split("/")[0])), s["first_p50"] or 99))
json.dump({"when": datetime.now(timezone.utc).isoformat(), "runs": RUNS, "questions": [(q, why) for q, _, why in QUESTIONS],
           "summary": summary, "results": results}, open("openrouter_eval.json", "w"), indent=1)
w = max(len(s["model"]) for s in summary)
print(f"{'model':{w}}  first p50  p90   total p50  correct  errors")
for s in summary:
    print(f"{s['model']:{w}}  {s['first_p50']!s:>8}  {s['first_p90']!s:>5}  {s['total_p50']!s:>8}   {s['correct']:>6}  {s['errors']:>5}")
print()
for s in summary:
    print(s["model"], " ".join(f"{v}" for v in s["per_question"].values()))
print("questions:", " | ".join(why for _, _, why in QUESTIONS))
