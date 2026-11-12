"""E2E check of the deployed app with a software passkey authenticator.
Usage: python3 -I e2e.py <url> <access_key>. Writes e2e-result.json. Exit code 0 when every check passes."""
import base64, hashlib, json, os, re, ssl, statistics, sys, time, urllib.error, urllib.request
from urllib.parse import quote
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

BASE, KEY = sys.argv[1].rstrip("/"), sys.argv[2]
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
UA = {"User-Agent": "Mozilla/5.0 quick-e2e", "Accept-Encoding": "identity"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None


OPENER = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=CTX))


def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def cbor(v):
    def head(major, n):
        if n < 24: return bytes([major << 5 | n])
        if n < 256: return bytes([major << 5 | 24, n])
        return bytes([major << 5 | 25]) + n.to_bytes(2, "big")
    if isinstance(v, int): return head(0, v) if v >= 0 else head(1, -1 - v)
    if isinstance(v, bytes): return head(2, len(v)) + v
    if isinstance(v, str): return head(3, len(v.encode())) + v.encode()
    return head(5, len(v)) + b"".join(cbor(k) + cbor(x) for k, x in v.items())


class Authenticator:
    """A platform authenticator in software: P-256 key, "none" attestation, user verified."""
    def __init__(self):
        self.key, self.id, self.count, self.user = ec.generate_private_key(ec.SECP256R1()), os.urandom(16), 0, None

    def _client_data(self, kind, challenge):
        return json.dumps({"type": kind, "challenge": challenge, "origin": BASE, "crossOrigin": False}).encode()

    def create(self, o):
        self.user = o["user"]["id"]
        n = self.key.public_key().public_numbers()
        cose = cbor({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")})
        auth = (hashlib.sha256(o["rp"]["id"].encode()).digest() + bytes([0x45]) + bytes(4) + bytes(16)
                + len(self.id).to_bytes(2, "big") + self.id + cose)
        return {"id": b64u(self.id), "rawId": b64u(self.id), "type": "public-key", "clientExtensionResults": {},
                "response": {"clientDataJSON": b64u(self._client_data("webauthn.create", o["challenge"])),
                             "attestationObject": b64u(cbor({"fmt": "none", "attStmt": {}, "authData": auth})),
                             "transports": ["internal"]}}

    def get(self, o):
        self.count += 1
        auth = hashlib.sha256(o["rpId"].encode()).digest() + bytes([0x05]) + self.count.to_bytes(4, "big")
        cd = self._client_data("webauthn.get", o["challenge"])
        sig = self.key.sign(auth + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64u(self.id), "rawId": b64u(self.id), "type": "public-key", "clientExtensionResults": {},
                "response": {"clientDataJSON": b64u(cd), "authenticatorData": b64u(auth),
                             "signature": b64u(sig), "userHandle": self.user}}


class Browser:
    """Keeps cookies like a browser does."""
    def __init__(self, access_key=True):
        self.cookies = {"k": KEY} if access_key else {}

    def open(self, path, body=None, method=None):
        headers = {**UA, "Cookie": "; ".join(f"{k}={v}" for k, v in self.cookies.items())}
        data = None if body is None else json.dumps(body).encode()
        if data: headers["content-type"] = "application/json"
        try:
            r = OPENER.open(urllib.request.Request(BASE + path, data, headers, method=method), timeout=60)
        except urllib.error.HTTPError as e:
            if e.code not in (301, 302): raise
            r = e
        for c in r.headers.get_all("Set-Cookie") or []:
            name, value = c.split(";")[0].split("=", 1)
            self.cookies[name] = value
        return r

    def json(self, path, body=None):
        return json.load(self.open(path, body, "POST"))

    def text(self, path):
        return self.open(path).read().decode()

    def chat_ids(self):
        return re.findall(r'"id":"(\w+)"', re.search(r"<script>L\((.*?)\)</script>", self.text("/")).group(1))


def signup(name):
    b, a = Browser(), Authenticator()
    o = b.json("/auth/register/options", {"name": name})
    return b, a, b.json("/auth/register/verify", a.create(o)).get("ok") is True


def search(b, q):
    t = time.perf_counter()
    r = b.open("/?q=" + quote(q))
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
try:
    Browser(access_key=False).open("/")
    checks["no_access_key_is_401"] = False
except urllib.error.HTTPError as e:
    checks["no_access_key_is_401"] = e.code == 401
checks["access_key_shows_passkey_page"] = "Sign in with passkey" in Browser().text("/")

alice, alice_key, ok_a = signup("e2e-alice")
bob, _, ok_b = signup("e2e-bob")
checks["register_passkey"] = ok_a and ok_b

again = Browser()
o = again.json("/auth/login/options")
checks["login_with_passkey"] = again.json("/auth/login/verify", alice_key.get(o)).get("ok") is True
o = again.json("/auth/login/options")
checks["login_twice_counter_ok"] = again.json("/auth/login/verify", alice_key.get(o)).get("ok") is True
o = Browser().json("/auth/login/options")
checks["unknown_passkey_rejected"] = "error" in Browser().json("/auth/login/verify", Authenticator().get(o))

leads = []


def answer(html):
    return "".join(json.loads(m) for m in re.findall(r"<script>T\((\".*?\")\)</script>", html))


for q in ["what is the capital of australia", "golden gate bridge",
          "who is the latest person jensen huang had an affair with"] * 2:
    ttfb, first, total, html = search(again, q)
    rows.append({"q": q, "ttfb": round(ttfb, 3), "first_token": round(first or -1, 3), "total": round(total, 3),
                 "inline_images": answer(html).count("](img:")})
    print(rows[-1], flush=True)
    if q == "golden gate bridge":
        bridge = html
    if "jensen" in q:
        leads.append(re.split(r"(?<=[.!?])\s", answer(html).strip(), 1)[0].lower())
plain = answer(search(again, "what is 17 times 23")[3])

chat_id = re.search(r'"id":"(\w+)"', bridge).group(1)
checks["answer_streams"] = "<script>T(" in bridge and "<script>D(" in bridge
checks["images_for_visual_query"] = "](img:" in answer(bridge)
checks["latest_news_leads_with_powell"] = all("powell" in lead for lead in leads)
checks["no_images_for_plain_fact"] = "391" in plain and "](img:" not in plain
time.sleep(1.5)
checks["chat_in_own_sidebar"] = chat_id in alice.chat_ids()
checks["chat_not_in_other_sidebar"] = chat_id not in bob.chat_ids()
checks["other_user_cannot_open_chat"] = bob.open(f"/c/{chat_id}").getcode() == 302
checks["saved_chat_has_images"] = '"images":["https' in alice.text(f"/c/{chat_id}")

msgs = [{"role": "user", "text": "golden gate bridge"}, {"role": "model", "text": "It is a suspension bridge in San Francisco."},
        {"role": "user", "text": "how long is it?"}]
t = time.perf_counter()
r = alice.open(f"/api/chats/{chat_id}", {"title": "e2e", "msgs": msgs}, "POST")
raw = b""
followup_ft = None
while chunk := r.read1(65536):
    raw += chunk
    if followup_ft is None and (b"\x00T" in raw or raw.startswith(b"T")):
        followup_ft = time.perf_counter() - t
frames = raw.decode().split("\u0000")
checks["followup_frames"] = any(f.startswith("T") for f in frames) and any(f.startswith("D") for f in frames)

out = Browser()
out.cookies = dict(alice.cookies)
out.open("/auth/logout")
checks["logout"] = "Sign in with passkey" in out.text("/")
osd = Browser(access_key=False).open("/opensearch.xml")
checks["opensearch_inline"] = "{searchTerms}" in osd.read().decode() and osd.headers["content-type"].startswith("text/xml")

for cid in alice.chat_ids():
    alice.open(f"/api/chats/{cid}", method="DELETE").read()
checks["delete"] = alice.chat_ids() == []

avg = {k: round(statistics.mean(r[k] for r in rows), 3) for k in ("ttfb", "first_token", "total")}
json.dump({"base": BASE, "runs": rows, "avg": avg, "followup_first_token": round(followup_ft, 3), "checks": checks},
          open("e2e-result.json", "w"), indent=1)
print("avg", avg, "follow-up first token", round(followup_ft, 3))
print(json.dumps(checks, indent=1))
sys.exit(0 if all(checks.values()) else 1)
