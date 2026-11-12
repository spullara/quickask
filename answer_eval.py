"""Answer quality vs first-token time for models given the same Exa search results.
Writes answer_eval.json. Usage: python3 -I answer_eval.py"""
import json, os, re, ssl, statistics, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
for line in open(os.path.expanduser("~/.env")):
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1)
        os.environ.setdefault(k, v.strip("'\""))

# (question, grader on the answer's first sentence, runs)
QUESTIONS = [
    ("who is the latest person jensen huang had an affair with", lambda s: "powell" in s, 5),
    ("latest jensen huang scandal", lambda s: "powell" in s, 3),
    ("who runs healthcare at nvidia", lambda s: "powell" in s, 2),
    ("what is 17 times 23", lambda s: "391" in s, 2),
]

BASE_RULES = """You are a fast answer engine. Answer the latest question, using the search results when they are relevant.
Lead with the direct answer in the first sentence. Keep it short; add detail only when it helps. Use Markdown."""
RECENCY = """Results are sorted newest first and show publish dates. For questions about the latest, newest, current or most
recent anything, the most recently published reports decide the answer: lead with what they say, then mention older context."""


def post(url, headers, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers})
    return urllib.request.urlopen(req, timeout=60, context=CTX)


def exa(q, newest_first):
    d = json.load(post("https://api.exa.ai/search", {"x-api-key": os.environ["EXA_API_KEY"]},
                       {"query": q, "type": "fast", "numResults": 10,
                        "contents": {"highlights": {"numSentences": 3, "highlightsPerUrl": 3}}}))
    rs = d["results"]
    if newest_first:
        rs = sorted(rs, key=lambda r: r.get("publishedDate") or "", reverse=True)
    return "\n\n".join(f"[{i+1}] {r.get('title')} ({r['url'].split('/')[2]}, {(r.get('publishedDate') or 'no date')[:10]})\n{' … '.join(r.get('highlights') or [])}"
                       for i, r in enumerate(rs))


def sse(resp, pick):
    t0, first, text = time.perf_counter(), None, ""
    for raw in resp:
        line = raw.decode().strip()
        if line.startswith("data:"):
            try:
                piece = pick(json.loads(line[5:]))
            except (json.JSONDecodeError, KeyError, IndexError, TypeError):
                continue
            if piece:
                first = first or time.perf_counter()
                text += piece
    return first, text


def gemini(model, thinking):
    def call(system, user):
        body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": [{"role": "user", "parts": [{"text": user}]}],
                "generationConfig": {"thinkingConfig": {"thinkingLevel": thinking}}}
        r = post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
                 {"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, body)
        return sse(r, lambda d: "".join(p.get("text", "") for p in d["candidates"][0]["content"]["parts"] if not p.get("thought")))
    return call


def claude(model):
    def call(system, user):
        r = post("https://api.anthropic.com/v1/messages", {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
                 {"model": model, "max_tokens": 700, "stream": True, "system": system, "messages": [{"role": "user", "content": user}]})
        return sse(r, lambda d: d["delta"]["text"] if d.get("type") == "content_block_delta" and d["delta"].get("type") == "text_delta" else "")
    return call


def openai(model, effort):
    def call(system, user):
        r = post("https://api.openai.com/v1/responses", {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                 {"model": model, "stream": True, "instructions": system, "input": user, "reasoning": {"effort": effort}})
        return sse(r, lambda d: d["delta"] if d.get("type") == "response.output_text.delta" else "")
    return call


CONFIGS = [
    ("gemini-3.5-flash-lite (current prompt)", gemini("gemini-3.5-flash-lite", "minimal"), False),
    ("gemini-3.5-flash-lite", gemini("gemini-3.5-flash-lite", "minimal"), True),
    ("gemini-3.8-flash low", gemini("gemini-3.8-flash", "low"), True),
    ("claude-haiku-5.5", claude("claude-haiku-5-5"), True),
    ("claude-sonnet-5.5", claude("claude-sonnet-5-5"), True),
    ("gpt-6-luna low", openai("gpt-6-luna", "low"), True),
    ("gpt-6.1-sol low", openai("gpt-6.1-sol", "low"), True),
]

today = datetime.now(timezone.utc).strftime("%a, %d %b %Y")
contexts = {(q, n): exa(q, n) for q, _, _ in QUESTIONS for n in (False, True)}


def run(cfg):
    name, call, recency = cfg
    system = f"Today is {today}.\n{BASE_RULES}" + (f"\n{RECENCY}" if recency else "")
    rows = []
    for q, grade, n in QUESTIONS:
        user = f"{q}\n\n<search_results>\n{contexts[(q, recency)]}\n</search_results>"
        for _ in range(n):
            t = time.perf_counter()
            try:
                first, text = call(system, user)
            except urllib.error.HTTPError as e:
                rows.append({"model": name, "q": q, "error": f"{e.code} {e.read()[:200]!r}"})
                break
            lead = re.split(r"(?<=[.!?])\s", text.strip(), 1)[0].lower()
            rows.append({"model": name, "q": q, "ttft": round((first or time.perf_counter()) - t, 3), "ok": grade(lead), "lead": lead[:160]})
    print(name, "done", file=sys.stderr, flush=True)
    return rows


with ThreadPoolExecutor(len(CONFIGS)) as ex:
    rows = [r for rs in ex.map(run, CONFIGS) for r in rs]
json.dump(rows, open("answer_eval.json", "w"), indent=1)

print("| Model | Correct | Latest-news correct | TTFT avg (s) |\n|---|---|---|---|")
for name, _, _ in CONFIGS:
    rs = [r for r in rows if r["model"] == name and "ok" in r]
    errs = [r["error"] for r in rows if r["model"] == name and "error" in r]
    if not rs:
        print(f"| {name} | error: {errs[0][:80]} | | |")
        continue
    news = [r for r in rs if "jensen" in r["q"]]
    print(f"| {name} | {sum(r['ok'] for r in rs)}/{len(rs)} | {sum(r['ok'] for r in news)}/{len(news)} | {statistics.mean(r['ttft'] for r in rs):.2f} |")
