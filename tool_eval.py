"""Search as a model tool vs direct search: first-token time, tool use and accuracy.
Writes tool_eval.json. Usage: python3 -I tool_eval.py"""
import json, os, re, ssl, statistics, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
for line in open(os.path.expanduser("~/.env")):
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1)
        os.environ.setdefault(k, v.strip("'\""))

RUNS = int(os.environ.get("RUNS", 3))
GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse"
QUESTIONS = [  # (question, grader on full answer text or None)
    ("what is the capital of australia", lambda t: "canberra" in t),
    ("who is the latest person jensen huang had an affair with", lambda t: "powell" in re.split(r"(?<=[.!?])\s", t, 1)[0]),
    ("who is older, jensen huang or lisa su", lambda t: "1963" in t or "jensen huang is older" in t),
    ("how many years apart were nvidia and amd founded", lambda t: "24" in t),
    ("compare the weather in san francisco and new york today", lambda t: "san francisco" in t and "new york" in t),
]
MULTI_HOP = [  # one raw-query search tends to miss one of the facts
    ("what is the capital of australia", lambda t: "canberra" in t),
    ("how old was the ceo of amd when nvidia was founded", lambda t: "23" in t),
    ("what is the population of the capital of the country that hosted the 2016 summer olympics", lambda t: "bras" in t),
    ("which is taller, the golden gate bridge towers or the eiffel tower", lambda t: "eiffel" in re.split(r"(?<=[.!?])\s", t, 1)[0]),
    ("who is the ceo of the company that makes the main competitor to nvidia's h100", lambda t: "lisa su" in t),
]
if os.environ.get("SET") == "multi":
    QUESTIONS = MULTI_HOP
SYSTEM = f"""Today is {datetime.now(timezone.utc).strftime('%a, %d %b %Y')}. You are a fast answer engine.
Lead with the direct answer in the first sentence. Keep it short; add detail only when it helps. Use Markdown.
Results are sorted newest first and show publish dates. For questions about the latest, newest, current or most recent
anything, the most recently published reports decide the answer."""
TOOL_HINT = """You have a web search tool. Search when you need facts you are not sure of, or fresh information.
Put every query you need in one call (they run in parallel): for a comparison, one query per item."""
PREFETCH_HINT = """Search results for the user's question are attached. If they are enough, answer immediately without
calling the tool. Call the search tool only when they miss something you need."""
TOOLS = [{"functionDeclarations": [{
    "name": "search", "description": "Search the web. Queries run in parallel.",
    "parameters": {"type": "object", "properties": {"queries": {"type": "array", "items": {"type": "string"},
                   "description": "1 to 3 focused search queries"}}, "required": ["queries"]}}]}]


def post(url, headers, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers})
    return urllib.request.urlopen(req, timeout=60, context=CTX)


def exa(q, n=10):
    d = json.load(post("https://api.exa.ai/search", {"x-api-key": os.environ["EXA_API_KEY"]},
                       {"query": q, "type": "fast", "numResults": n,
                        "contents": {"highlights": {"numSentences": 3, "highlightsPerUrl": 3}}}))
    rs = sorted(d["results"], key=lambda r: r.get("publishedDate") or "", reverse=True)
    return "\n\n".join(f"[{r['url'].split('/')[2]}, {(r.get('publishedDate') or 'no date')[:10]}] {r.get('title')}\n"
                       + " … ".join(r.get("highlights") or []) for r in rs)


def exa_many(queries):
    with ThreadPoolExecutor(len(queries)) as ex:
        return "\n\n".join(f"<results query={json.dumps(q)}>\n{r}\n</results>" for q, r in zip(queries, ex.map(lambda q: exa(q, 6), queries)))


def stream(contents, system, tools, t0):
    """One streamed Gemini call. Returns (first text time, text, function call args or None, model parts)."""
    body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents,
            "generationConfig": {"thinkingConfig": {"thinkingLevel": "minimal"}}}
    if tools:
        body["tools"] = TOOLS
    first, text, call, parts = None, "", None, []
    for raw in post(GEMINI, {"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, body):
        line = raw.decode().strip()
        if not line.startswith("data:"):
            continue
        for p in json.loads(line[5:]).get("candidates", [{}])[0].get("content", {}).get("parts", []):
            parts.append(p)
            if "functionCall" in p:
                call = p["functionCall"].get("args", {})
            elif p.get("text") and not p.get("thought"):
                first = first or time.perf_counter() - t0
                text += p["text"]
    return first, text, call, parts


def run(mode, q):
    t0 = time.perf_counter()
    queries = []
    if mode == "direct":
        contents = [{"role": "user", "parts": [{"text": f"{q}\n\n<search_results>\n{exa(q)}\n</search_results>"}]}]
        first, text, _, _ = stream(contents, SYSTEM, False, t0)
        return first, text, queries
    if mode == "prefetch+tool":
        contents = [{"role": "user", "parts": [{"text": f"{q}\n\n<search_results>\n{exa(q)}\n</search_results>"}]}]
        system = f"{SYSTEM}\n{TOOL_HINT}\n{PREFETCH_HINT}"
    else:
        contents = [{"role": "user", "parts": [{"text": q}]}]
        system = f"{SYSTEM}\n{TOOL_HINT}"
    for round_ in range(3):
        first, text, call, parts = stream(contents, system, round_ < 2, t0)
        if not call:
            return first, text, queries
        qs = (call.get("queries") or [q])[:3]
        queries += qs
        contents += [{"role": "model", "parts": parts},
                     {"role": "user", "parts": [{"functionResponse": {"name": "search", "response": {"results": exa_many(qs)}}}]}]
    return first, text, queries


MODES = ["direct", "tool-first", "prefetch+tool"]


def job(mode):
    rows = []
    for q, grade in QUESTIONS:
        for _ in range(RUNS):
            try:
                first, text, queries = run(mode, q)
                rows.append({"mode": mode, "q": q, "ttft": round(first or -1, 3), "ok": grade(text.lower()),
                             "queries": queries, "lead": text.strip()[:160]})
            except Exception as e:
                rows.append({"mode": mode, "q": q, "error": f"{e} {getattr(e, 'read', lambda: b'')()[:300]!r}"})
    print(mode, "done", file=sys.stderr, flush=True)
    return rows


with ThreadPoolExecutor(len(MODES)) as ex:
    rows = [r for rs in ex.map(job, MODES) for r in rs]
json.dump(rows, open(f"tool_eval_{os.environ.get('SET', 'base')}.json", "w"), indent=1)

print("| Mode | Correct | First token avg (s) | Searched again | Easy question first token (s) | Hard questions first token (s) |")
print("|---|---|---|---|---|---|")
for m in MODES:
    rs = [r for r in rows if r["mode"] == m and "ok" in r]
    errs = [r["error"] for r in rows if r["mode"] == m and "error" in r]
    if errs:
        print(f"<!-- {m} errors: {errs[0][:300]} -->")
    if not rs:
        continue
    easy = [r["ttft"] for r in rs if "australia" in r["q"]]
    hard = [r["ttft"] for r in rs if "australia" not in r["q"]]
    print(f"| {m} | {sum(r['ok'] for r in rs)}/{len(rs)} | {statistics.mean(r['ttft'] for r in rs):.2f} | "
          f"{sum(bool(r['queries']) for r in rs)}/{len(rs)} | {statistics.mean(easy):.2f} | {statistics.mean(hard):.2f} |")
