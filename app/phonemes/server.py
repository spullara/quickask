"""POST {"sentences": [...]} -> [{"ids": [...], "stress": [...]}] (null for a sentence it cannot read).
The lexicon and g2p model load once at start-up; each request then takes a few milliseconds."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import dizione

dizione.phonemize("Ready.")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        out = []
        for sentence in (body.get("sentences") or [])[:60]:
            text = str(sentence).strip()[:600]
            try:
                p = dizione.phonemize(text) if text else None
            except Exception:
                p = None
            out.append({"ids": list(p.ids), "stress": list(p.stress)} if p else None)
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
