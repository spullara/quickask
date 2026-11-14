"""Parallel.ai Search as an Exa replacement: the same model (Gemini 3.5 Flash Lite), the production prompt, and each
search provider's results. Measures search time, first token after the search, context size and graded answers.
Parallel has no images in search results, so its Image Search runs at the same time. Writes parallel_eval.json.
Usage: python3 -I parallel_eval.py [runs per question]"""
import json, os, re, ssl, statistics, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
for line in open(os.path.expanduser("~/.env")):
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1)
        os.environ.setdefault(k, v.strip("'\""))
RUNS = int(sys.argv[1]) if len(sys.argv) > 1 else 3

src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "app/src/worker.ts")).read()
SYSTEM = re.search(r"const SYSTEM = `(.*?)`;", src, re.S).group(1).replace("${FOLLOWUPS}", ":::followups")
SYSTEM = f"Today is {datetime.now(timezone.utc):%A, %B %d, %Y}.\n" + SYSTEM

first = lambda a: re.split(r"(?<=[.!?])\s", a.strip().split("\n")[0], 1)[0].lower()
lead = lambda a: a.strip().split("\n")[0].lower()
QUESTIONS = [
    # News as of Nov 13, 2026: after Kimberly Powell (Nov 11), Reuters reported a third, unnamed Nvidia employee.
    ("who is the latest person jensen huang had an affair with",
     lambda a: re.search(r"third|unnamed|not (been )?(publicly )?(named|identified)|undisclosed|withheld|unidentified", first(a)), "latest = third, unnamed employee"),
    ("how old was the ceo of amd when nvidia was founded", lambda a: re.search(r"\b23\b", first(a)), "leads with 23"),
    ("what is the capital of australia", lambda a: "canberra" in first(a), "Canberra"),
    ("github", lambda a: re.match(r"^\s*\[[^\]]+\]\(https://github\.com/?\)", a) is not None, "GitHub link first"),
    ("golden gate bridge", lambda a: "](img:" in a, "shows a picture"),
    ("who won the 2026 world series", lambda a: "dodgers" in first(a) or "yankees" in first(a) or "won" in first(a), "names a winner"),
    ("I'm a baby bear and I lost my mommy", lambda a: not re.search(r"\b(little (one|buddy|bear)|if you are (a|an) (real |lost )?(baby )?(bear|cub)|stay safe)\b", lead(a)), "no role-play"),
]


def post(url, headers, body, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, json.dumps(body).encode(),
                                  {"content-type": "application/json", "User-Agent": "Mozilla/5.0", **headers}), timeout=timeout, context=CTX)


def exa(q):
    d = json.load(post("https://api.exa.ai/search", {"x-api-key": os.environ["EXA_API_KEY"]},
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
    return "\n\n".join(parts)


def parallel(mode):
    key = {"x-api-key": os.environ["PARALLEL_API_KEY"]}

    def search(q):
        def text():
            return json.load(post("https://api.parallel.ai/v1/search", key,
                                  {"mode": mode, "objective": q, "search_queries": [q], "advanced_settings": {"max_results": 10}}))["results"]

        def images():
            try:
                return json.load(post("https://api.parallel.ai/v1/images/search", key,
                                      {"mode": "fast", "objective": q, "search_queries": [q]}, timeout=10))["results"]
            except Exception:
                return []
        with ThreadPoolExecutor(2) as ex:
            t, i = ex.submit(text), ex.submit(images)
            rs, imgs = t.result(), i.result()
        rs = sorted(rs, key=lambda r: r.get("publish_date") or "", reverse=True)
        # Each image is listed under the result it came from, or after the results.
        by_page, extra, n = {}, [], 0
        for im in imgs:
            if n >= 12 or not (im.get("image_url") or "").startswith("https://"):
                continue
            n += 1
            by_page.setdefault(im.get("source_page_url"), []).append(f"img:{n}")
            extra.append((f"img:{n}", im.get("title") or "", im.get("source_page_url") or ""))
        parts = []
        for i, r in enumerate(rs):
            ids = by_page.pop(r["url"], [])
            date = f", {r['publish_date'][:10]}" if r.get("publish_date") else ""
            parts.append(f"[{i+1}] {r.get('title') or r['url']} ({r['url']}{date})\n{' … '.join(r.get('excerpts') or [])}"
                         + (f"\nImages: {', '.join(ids)}" if ids else ""))
        left = [f"{i} {t} ({u})" for i, t, u in extra if any(i in v for v in by_page.values())]
        if left:
            parts.append("Images from image search: " + "; ".join(left))
        return "\n\n".join(parts)
    return search


def gemini(user):
    body = {"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"thinkingConfig": {"thinkingLevel": "minimal"}}}
    r = post("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:streamGenerateContent?alt=sse",
             {"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, body)
    t0, first_t, text = time.perf_counter(), None, ""
    for raw in r:
        line = raw.decode(errors="ignore").strip()
        if not line.startswith("data:"):
            continue
        try:
            piece = "".join(p.get("text", "") for p in json.loads(line[5:])["candidates"][0]["content"]["parts"] if not p.get("thought"))
        except (json.JSONDecodeError, KeyError, IndexError):
            continue
        if piece:
            first_t = first_t or time.perf_counter()
            text += piece
    return first_t, text


SEARCHES = {"exa fast (production)": exa, "parallel turbo": parallel("turbo"), "parallel fast": parallel("fast"), "parallel basic": parallel("basic")}


def run(name):
    search, out = SEARCHES[name], []
    for q, grade, _ in QUESTIONS:
        for _ in range(RUNS):
            t0 = time.perf_counter()
            try:
                ctx = search(q)
                t1 = time.perf_counter()
                f, text = gemini(f"{q}\n\n<search_results>\n{ctx}\n</search_results>")
                out.append({"q": q, "search": round(t1 - t0, 3), "first_after_search": round(f - t1, 3) if f else None,
                            "first": round(f - t0, 3) if f else None, "chars": len(ctx), "ok": bool(grade(text)), "answer": text[:400]})
            except Exception as e:
                out.append({"q": q, "error": (f"{e.code} {e.read().decode()[:200]}" if isinstance(e, urllib.error.HTTPError) else repr(e))[:300]})
    return name, out


with ThreadPoolExecutor(len(SEARCHES)) as ex:
    results = dict(ex.map(run, SEARCHES))

med = lambda xs: round(statistics.median(xs), 2) if xs else None
summary = []
for name, rows in results.items():
    good = [r for r in rows if "error" not in r and r["first"]]
    summary.append({"search": name, "search_p50": med([r["search"] for r in good]), "first_after_search_p50": med([r["first_after_search"] for r in good]),
                    "first_p50": med([r["first"] for r in good]), "context_chars_p50": med([r["chars"] for r in good]),
                    "correct": f"{sum(r['ok'] for r in good)}/{len(rows)}", "errors": len(rows) - len(good),
                    "per_question": [f"{sum(r['ok'] for r in good if r['q'] == q)}/{sum(1 for r in good if r['q'] == q)}" for q, _, _ in QUESTIONS]})
json.dump({"when": datetime.now(timezone.utc).isoformat(), "runs": RUNS, "questions": [(q, why) for q, _, why in QUESTIONS],
           "summary": summary, "results": results}, open("parallel_eval.json", "w"), indent=1)
print(f"{'search':22} search  model-first  first-token  context  correct  errors")
for s in summary:
    print(f"{s['search']:22} {s['search_p50']!s:>6}  {s['first_after_search_p50']!s:>11}  {s['first_p50']!s:>11}  {s['context_chars_p50']!s:>7}  {s['correct']:>7}  {s['errors']:>6}")
print()
for s in summary:
    print(f"{s['search']:22}", " ".join(s["per_question"]))
print("questions:", " | ".join(why for _, _, why in QUESTIONS))
