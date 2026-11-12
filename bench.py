"""Latency benchmark: fast models with web search answering one factual question."""
import json, os, ssl, statistics, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

RUNS = int(os.environ.get("RUNS", 10))
QUESTION = ("Use web search. Who is NVIDIA's Vice President and General Manager of "
            "Healthcare? Reply with only the person's full name.")
EXPECT = "kimberly powell"
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")


def load_env(path=os.path.expanduser("~/.env")):
    for line in open(path):
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v.strip().strip('"').strip("'"))


def post(url, headers, body, timeout=120):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
        return json.load(r)


def openai(model):
    d = post("https://api.openai.com/v1/responses",
             {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
             {"model": model, "input": QUESTION, "tools": [{"type": "web_search"}],
              "reasoning": {"effort": "low"}})
    return d.get("output_text") or "".join(
        c.get("text", "") for o in d["output"] if o["type"] == "message" for c in o["content"])


def gemini(model):
    d = post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
             {"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
             {"contents": [{"parts": [{"text": QUESTION}]}], "tools": [{"google_search": {}}]})
    return "".join(p.get("text", "") for p in d["candidates"][0]["content"]["parts"])


def openrouter(model):
    d = post("https://openrouter.ai/api/v1/chat/completions",
             {"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}"},
             {"model": model, "messages": [{"role": "user", "content": QUESTION}], "max_tokens": 400,
              "plugins": [{"id": "web", "engine": "native"}]})
    return d["choices"][0]["message"]["content"]


MODELS = [
    ("Anthropic", "claude-haiku-5.5", lambda: openrouter("anthropic/claude-haiku-5.5")),
    ("Anthropic", "claude-sonnet-5.5", lambda: openrouter("anthropic/claude-sonnet-5.5")),
    ("OpenAI", "gpt-6-luna", lambda: openai("gpt-6-luna")),
    ("OpenAI", "gpt-6.1-sol", lambda: openai("gpt-6.1-sol")),
    ("OpenAI", "gpt-5.4-nano", lambda: openai("gpt-5.4-nano")),
    ("Google", "gemini-3.8-flash", lambda: gemini("gemini-3.8-flash")),
    ("Google", "gemini-3.5-flash-lite", lambda: gemini("gemini-3.5-flash-lite")),
]


def bench(entry):
    vendor, name, fn = entry
    rows = []
    for i in range(RUNS):
        t = time.perf_counter()
        try:
            text, err = fn(), None
        except Exception as e:
            text, err = "", f"{type(e).__name__}: {getattr(e, 'read', lambda: b'')()[:200]!r} {e}"
        dt = time.perf_counter() - t
        rows.append({"vendor": vendor, "model": name, "run": i + 1, "seconds": round(dt, 3),
                     "correct": EXPECT in text.lower(), "answer": text.strip()[:200], "error": err})
        print(f"{name:24} #{i+1:<2} {dt:6.2f}s {'OK ' if rows[-1]['correct'] else 'BAD'} {err or text.strip()[:60]!r}",
              file=sys.stderr, flush=True)
    return rows


if __name__ == "__main__":
    load_env()
    with ThreadPoolExecutor(len(MODELS)) as ex:
        results = [r for rows in ex.map(bench, MODELS) for r in rows]
    json.dump(results, open("results.json", "w"), indent=1)
    print(f"\n| Vendor | Model | Avg (s) | Median (s) | Min | Max | Correct | Errors |\n|---|---|---|---|---|---|---|---|")
    summary = []
    for vendor, name, _ in MODELS:
        rs = [r for r in results if r["model"] == name]
        ok = [r["seconds"] for r in rs if not r["error"]]
        if ok:
            summary.append((statistics.mean(ok), vendor, name, statistics.median(ok), min(ok), max(ok),
                            sum(r["correct"] for r in rs), sum(bool(r["error"]) for r in rs)))
        else:
            summary.append((float("inf"), vendor, name, 0, 0, 0, 0, len(rs)))
    for avg, vendor, name, med, lo, hi, correct, errs in sorted(summary):
        print(f"| {vendor} | {name} | {avg:.2f} | {med:.2f} | {lo:.2f} | {hi:.2f} | {correct}/{RUNS} | {errs} |")
