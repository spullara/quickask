"""E2E check of the deployed app. Usage: python3 -I e2e.py <url> <access_key>. Writes e2e-result.json."""
import json, re, ssl, statistics, sys, time, urllib.parse, urllib.request

BASE, KEY = sys.argv[1].rstrip("/"), sys.argv[2]
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
UA = {"User-Agent": "Mozilla/5.0 quick-e2e", "Accept-Encoding": "identity"}
COOKIE = {**UA, "Cookie": f"k={KEY}"}


def open_(path, data=None, method=None, headers=COOKIE):
    req = urllib.request.Request(BASE + path, data, headers, method=method)
    return urllib.request.urlopen(req, timeout=60, context=CTX)


def search(q):
    t = time.perf_counter()
    r = open_("/?q=" + urllib.parse.quote(q))
    ttfb = first = None
    body = b""
    while chunk := r.read1(65536):
        now = time.perf_counter() - t
        ttfb = ttfb or now
        body += chunk
        if first is None and b"<script>T(" in body:
            first = now
    return ttfb, first, time.perf_counter() - t, body.decode()


checks, rows = {}, []
for q in ["what is the capital of australia", "who is the latest person jensen huang had an affair with",
          "weather in san francisco today"] * 3:
    ttfb, first, total, html = search(q)
    rows.append({"q": q, "ttfb": round(ttfb, 3), "first_token": round(first or -1, 3), "total": round(total, 3)})
    print(rows[-1], flush=True)

answer = "".join(json.loads(m) for m in re.findall(r"<script>T\((\".*?\")\)</script>", html))
chat_id = re.search(r'"id":"(\w+)"', html).group(1)
checks["streamed_answer_nonempty"] = len(answer) > 0
checks["done_event"] = "<script>D(" in html
checks["sidebar_event"] = "<script>L(" in html

time.sleep(1.5)
checks["chat_saved"] = chat_id in open_("/").read().decode()
page = open_(f"/c/{chat_id}").read().decode()
checks["chat_page_has_answer"] = answer[:20] in page

msgs = [{"role": "user", "text": "who is the latest person jensen huang had an affair with"},
        {"role": "model", "text": "Kimberly Powell"}, {"role": "user", "text": "what is her job?"}]
t = time.perf_counter()
r = open_(f"/api/chats/{chat_id}", json.dumps({"title": "e2e", "msgs": msgs}).encode(), "POST")
first = r.read1(64); ft = time.perf_counter() - t
rest = (first + r.read()).decode()
checks["followup_streams"] = "\u0000" in rest and len(rest.split("\u0000")[0]) > 0
checks["followup_mentions_healthcare"] = "health" in rest.lower()
print("follow-up first token", round(ft, 3), "s:", rest.split("\u0000")[0][:100])

try:
    open_("/", headers=UA)
    checks["no_cookie_is_401"] = False
except urllib.error.HTTPError as e:
    checks["no_cookie_is_401"] = e.code == 401
checks["opensearch"] = "{searchTerms}" in open_("/opensearch.xml", headers=UA).read().decode()
open_(f"/api/chats/{chat_id}", method="DELETE").read()
checks["delete"] = chat_id not in open_("/").read().decode()

summary = {k: round(statistics.mean(r[k] for r in rows), 3) for k in ("ttfb", "first_token", "total")}
json.dump({"base": BASE, "runs": rows, "avg": summary, "followup_first_token": round(ft, 3), "checks": checks},
          open("e2e-result.json", "w"), indent=1)
print("avg", summary)
print(json.dumps(checks, indent=1))
sys.exit(0 if all(checks.values()) else 1)
