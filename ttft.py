"""Time-to-first-token probe for streaming + web search configurations."""
import json, os, ssl, statistics, sys, time, urllib.request

CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
RUNS = int(os.environ.get("RUNS", 5))
QS = ["who is the latest person jensen huang had an affair with",
      "what is the capital of australia",
      "weather in san francisco today"]

for line in open(os.path.expanduser("~/.env")):
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1)
        os.environ.setdefault(k, v.strip("'\""))


def stream(url, headers, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers})
    t = time.perf_counter()
    first = None
    with urllib.request.urlopen(req, timeout=60, context=CTX) as r:
        for raw in r:
            line = raw.decode().strip()
            if not line.startswith("data:"):
                continue
            s = line[5:]
            if first is None and ('"text"' in s and ('"text_delta"' in s or '"parts"' in s)):
                first = time.perf_counter() - t
    return first, time.perf_counter() - t


def gemini(model, thinking=None):
    body = {"contents": [{"parts": [{"text": Q}]}], "tools": [{"google_search": {}}]}
    if thinking:
        body["generationConfig"] = {"thinkingConfig": thinking}
    return stream(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
                  {"x-goog-api-key": os.environ["GEMINI_API_KEY"]}, body)


def claude(model):
    return stream("https://api.anthropic.com/v1/messages",
                  {"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01"},
                  {"model": model, "max_tokens": 600, "stream": True, "messages": [{"role": "user", "content": Q}],
                   "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 2}]})


CONFIGS = {
    "gemini-3.5-flash-lite": lambda: gemini("gemini-3.5-flash-lite"),
    "gemini-3.5-flash-lite minimal": lambda: gemini("gemini-3.5-flash-lite", {"thinkingLevel": "minimal"}),
    "gemini-3.8-flash minimal": lambda: gemini("gemini-3.8-flash", {"thinkingLevel": "minimal"}),
    "claude-haiku-5.5": lambda: claude("claude-haiku-5-5"),
}

print("| Config | Question | TTFT avg (s) | Total avg (s) |\n|---|---|---|---|")
for name, fn in CONFIGS.items():
    for Q in QS:
        ft, tt = [], []
        for _ in range(RUNS):
            try:
                f, t = fn()
                ft.append(f or t); tt.append(t)
            except Exception as e:
                print(f"{name}: {e} {getattr(e, 'read', lambda: b'')()[:200]}", file=sys.stderr)
                break
        if ft:
            print(f"| {name} | {Q[:32]} | {statistics.mean(ft):.2f} | {statistics.mean(tt):.2f} |", flush=True)
