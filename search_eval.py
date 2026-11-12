"""Exa vs Keenable as the search behind QuickAsk: latency, retrieval and answer accuracy.
Each provider's results go to Gemini 3.5 Flash Lite with the app's own prompt. Writes search_eval.json.
Usage: python3 -I search_eval.py"""
import json, os, re, ssl, statistics, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor

CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)
for line in open(os.path.expanduser("~/.env")):
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1)
        os.environ.setdefault(k, v.strip("'\""))

SRC = open(os.path.join(os.path.dirname(__file__), "app/src/worker.ts")).read()
SYSTEM = SRC.split("const SYSTEM = `")[1].split("`;")[0]

# (question, accepted answers in lower case, check only the first sentence)
QUESTIONS = [
    ("what is the capital of australia", ["canberra"], False),
    ("who wrote pride and prejudice", ["austen"], False),
    ("what year did the berlin wall fall", ["1989"], False),
    ("how many moons does mars have", ["two", "2 moons"], False),
    ("what is the chemical symbol for gold", ["au"], False),
    ("tallest mountain in africa", ["kilimanjaro"], False),
    ("how tall is the eiffel tower", ["330", "1,083", "1083"], False),
    ("what year did the golden gate bridge open", ["1937"], False),
    ("who is the ceo of amd", ["lisa su"], False),
    ("who co-founded nvidia with jensen huang", ["malachowsky", "priem"], False),
    ("who is nvidia's vp of healthcare", ["kimberly powell"], False),
    ("who is the latest person jensen huang had an affair with", ["powell"], True),
    ("which woman did jensen huang admit to an affair with in his november 8 letter", ["alice huang"], False),
    ("how old was the ceo of amd when nvidia was founded", ["23"], False),
    ("what is the population of the capital of the country that hosted the 2016 summer olympics", ["bras"], False),
    ("gemini 3.5 flash lite api price per million input tokens", ["0.30", "0.3 "], False),
    ("cloudflare workers paid plan minimum monthly price", ["$5", "5 usd", "5 dollars"], False),
    ("cloudflare durable objects sqlite rows written price per million", ["1.00", "$1 "], False),
    ("what is the alchemy.run v2 infrastructure framework built on", ["effect"], False),
    ("keenable search api modes", ["realtime"], False),
]


def post(url, headers, body, timeout=30):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", "user-agent": "quickask-eval", **headers})
    return json.load(urllib.request.urlopen(req, timeout=timeout, context=CTX))


def exa(q):
    d = post("https://api.exa.ai/search", {"x-api-key": os.environ["EXA_API_KEY"]},
             {"query": q, "type": "fast", "numResults": 10, "contents": {"highlights": {"numSentences": 3, "highlightsPerUrl": 3}}})
    return [(r.get("title") or "", r["url"], r.get("publishedDate") or "", " … ".join(r.get("highlights") or [])) for r in d["results"]]


def keenable(mode):
    def run(q):
        d = post("https://api.keenable.ai/v1/search", {"X-API-Key": os.environ["KEENABLE_API_KEY"]},
                 {"query": q, "mode": mode, "max_results": 10, "snippet_max_length": 600})
        return [(r.get("title") or "", r["url"], r.get("published_at") or "", r.get("snippet") or "") for r in d["results"]]
    return run


PROVIDERS = {"exa fast": exa, "keenable realtime": keenable("realtime"), "keenable pro": keenable("pro")}


def context(results):
    rs = sorted(results, key=lambda r: r[2], reverse=True)  # newest first, as the app does
    return "\n\n".join(f"[{i + 1}] {t} ({u.split('/')[2]}{', ' + d[:10] if d else ''})\n{s}" for i, (t, u, d, s) in enumerate(rs))


def gemini(q, ctx):
    body = {"systemInstruction": {"parts": [{"text": f"Today is {time.strftime('%a, %d %b %Y')}.\n{SYSTEM}"}]},
            "contents": [{"role": "user", "parts": [{"text": f"{q}\n\n<search_results>\n{ctx}\n</search_results>"}]}],
            "generationConfig": {"thinkingConfig": {"thinkingLevel": "minimal"}}}
    req = urllib.request.Request("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse",
                                 json.dumps(body).encode(), {"content-type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
    t, first, text = time.perf_counter(), None, ""
    for raw in urllib.request.urlopen(req, timeout=60, context=CTX):
        line = raw.decode().strip()
        if line.startswith("data:"):
            for p in json.loads(line[5:]).get("candidates", [{}])[0].get("content", {}).get("parts", []):
                if p.get("text") and not p.get("thought"):
                    first = first or time.perf_counter() - t
                    text += p["text"]
    return first, text


def hit(text, answers, lead):
    t = text.lower()
    if lead:
        t = re.split(r"(?<=[.!?])\s", t.strip(), maxsplit=1)[0]
    return any(a in t for a in answers)


def job(name):
    rows = []
    for q, answers, lead in QUESTIONS:
        t = time.perf_counter()
        try:
            results = PROVIDERS[name](q)
        except urllib.error.HTTPError as e:
            rows.append({"provider": name, "q": q, "error": f"{e.code} {e.read()[:200]!r}"})
            continue
        search_s = time.perf_counter() - t
        ctx = context(results)
        first, answer = gemini(q, ctx)
        rows.append({"provider": name, "q": q, "search_s": round(search_s, 3), "first_token_s": round(search_s + (first or 0), 3),
                     "results": len(results), "context_chars": len(ctx), "retrieved": hit(ctx, answers, False),
                     "correct": hit(answer, answers, lead), "answer": answer.strip()[:200]})
    print(name, "done", file=sys.stderr, flush=True)
    return rows


# One provider at a time, so they do not compete for bandwidth; questions run in order.
rows = [r for name in PROVIDERS for r in job(name)]
json.dump(rows, open("search_eval.json", "w"), indent=1)

pct = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
print("| Search | Search p50 (s) | Search p90 (s) | First token p50 (s) | Answer in results | Correct answers | Context size |")
print("|---|---|---|---|---|---|---|")
for name in PROVIDERS:
    rs = [r for r in rows if r["provider"] == name and "search_s" in r]
    errs = [r for r in rows if r["provider"] == name and "error" in r]
    if not rs:
        print(f"| {name} | errors: {errs[0]['error'][:80] if errs else '?'} |")
        continue
    s = [r["search_s"] for r in rs]
    print(f"| {name} | {statistics.median(s):.2f} | {pct(s, .9):.2f} | {statistics.median(r['first_token_s'] for r in rs):.2f} | "
          f"{sum(r['retrieved'] for r in rs)}/{len(rs)} | {sum(r['correct'] for r in rs)}/{len(rs)} | {int(statistics.mean(r['context_chars'] for r in rs))} chars |"
          + (f" ({len(errs)} errors)" if errs else ""))
