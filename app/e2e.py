"""E2E check of the deployed app with a software passkey authenticator.
Usage: python3 -I e2e.py <url> <access_key>. Writes e2e-result.json. Exit code 0 when every check passes."""
import base64, hashlib, json, os, re, ssl, statistics, sys, time, urllib.error, urllib.request
from urllib.parse import quote
import urllib.parse
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

BASE, KEY = sys.argv[1].rstrip("/"), sys.argv[2]
# With email sign-up codes on, the test proves it knows SESSION_SECRET (from app/.env) to get codes for @example.com without mail.
def _secret():
    try:
        return next(l.split("=", 1)[1].strip() for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")) if l.startswith("SESSION_SECRET="))
    except (OSError, StopIteration):
        return os.environ.get("SESSION_SECRET", "")
E2E = hashlib.sha256(f"{_secret()}:e2e".encode()).hexdigest()
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem" if os.path.exists("/etc/ssl/cert.pem") else None)
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
        self.uv = 0x04  # user verified; 0 for a passkey app that skips Face ID or a PIN

    def _client_data(self, kind, challenge):
        return json.dumps({"type": kind, "challenge": challenge, "origin": BASE, "crossOrigin": False}).encode()

    def create(self, o):
        self.user = o["user"]["id"]
        n = self.key.public_key().public_numbers()
        cose = cbor({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")})
        auth = (hashlib.sha256(o["rp"]["id"].encode()).digest() + bytes([0x41 | self.uv]) + bytes(4) + bytes(16)
                + len(self.id).to_bytes(2, "big") + self.id + cose)
        return {"id": b64u(self.id), "rawId": b64u(self.id), "type": "public-key", "clientExtensionResults": {},
                "response": {"clientDataJSON": b64u(self._client_data("webauthn.create", o["challenge"])),
                             "attestationObject": b64u(cbor({"fmt": "none", "attStmt": {}, "authData": auth})),
                             "transports": ["internal"]}}

    def get(self, o):
        self.count += 1
        auth = hashlib.sha256(o["rpId"].encode()).digest() + bytes([0x01 | self.uv]) + self.count.to_bytes(4, "big")
        cd = self._client_data("webauthn.get", o["challenge"])
        sig = self.key.sign(auth + hashlib.sha256(cd).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64u(self.id), "rawId": b64u(self.id), "type": "public-key", "clientExtensionResults": {},
                "response": {"clientDataJSON": b64u(cd), "authenticatorData": b64u(auth),
                             "signature": b64u(sig), "userHandle": self.user}}


class Browser:
    """Keeps cookies like a browser does."""
    def __init__(self, access_key=True, e2e=False):
        self.cookies = {"k": KEY} if access_key else {}
        self.e2e = e2e

    def open(self, path, body=None, method=None):
        headers = {**UA, **({"x-e2e": E2E} if self.e2e else {}), "Cookie": "; ".join(f"{k}={v}" for k, v in self.cookies.items())}
        data = None if body is None else json.dumps(body).encode()
        if data: headers["content-type"] = "application/json"
        try:
            r = OPENER.open(urllib.request.Request(BASE + path, data, headers, method=method), timeout=120)
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


WAIT, ADMIN = {}, Browser(e2e=True)


def status(b, path):
    try:
        return b.open(path).getcode()
    except urllib.error.HTTPError as e:
        return e.code


def signup(name, uv=True):
    """Waitlist sign-up: email link, admin approval, then a software passkey. Accounts are named by email address."""
    name = name if "@" in name else f"{name}@example.com"
    b, a = Browser(e2e=True), Authenticator()
    a.uv = 0x04 if uv else 0
    link = b.json("/auth/waitlist", {"email": name}).get("link", "")
    WAIT["early_signup_refused"] = "not approved" in b.json("/auth/register/options", {"name": name}).get("error", "")
    b.open(link[len(BASE):])
    WAIT["link_puts_on_waitlist"] = "on the waitlist as " + name in b.text("/")
    WAIT["waiting_cannot_register"] = "not approved" in b.json("/auth/register/options", {}).get("error", "")
    approved = ADMIN.json("/api/admin/approve", {"email": name})
    b.open(approved.get("link", "")[len(BASE):])
    WAIT["approved_sees_create"] = "Create passkey" in b.text("/")
    # An older email link still works after a newer email was sent.
    WAIT["older_link_still_works"] = status(Browser(), link[len(BASE):]) == 302
    o = b.json("/auth/register/options", {})
    b.e2e = False
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
home = Browser(access_key=False).text("/")
checks["public_page_offers_waitlist"] = "Sign in with passkey" in home and "Join the waitlist" in home

RUN = os.urandom(3).hex()
alice, alice_key, ok_a = signup(f"e2e-alice-{RUN}")
bob, _, ok_b = signup(f"e2e-bob-{RUN}")
checks["register_passkey"] = ok_a and ok_b
_, dave_key, ok_d = signup(f"e2e-dave-{RUN}", uv=False)
o = (dave := Browser()).json("/auth/login/options")
checks["passkey_without_user_verification"] = ok_d and dave.json("/auth/login/verify", dave_key.get(o)).get("ok") is True
checks.update(WAIT)
checks["email_must_be_unique"] = "already has an account" in Browser().json("/auth/waitlist", {"email": f"E2E-ALICE-{RUN}@EXAMPLE.COM"}).get("error", "")
carol = Browser(e2e=True)
carol.json("/auth/waitlist", {"email": f"e2e-carol-{RUN}@example.com"})
checks["resend_waits"] = "Wait 30 seconds" in carol.json("/auth/waitlist", {"email": f"e2e-carol-{RUN}@example.com"}).get("error", "")
checks["bad_link_refused"] = status(carol, f"/auth/confirm?e=e2e-carol-{RUN}%40example.com&t=wrong") == 400
checks["name_must_be_email"] = Browser().json("/auth/waitlist", {"email": "not an email"}).get("error") == "Enter a valid email address."
forged = Browser()
forged.json("/auth/login/options")
forged.cookies["s"] = forged.cookies["c"]
checks["other_signed_cookie_is_not_a_session"] = "Sign in with passkey" in forged.text("/")
checks["admin_api_hidden_from_users"] = status(alice, "/api/admin/approve") == 404
checks["usage_hidden_from_users"] = status(alice, "/api/usage") == 404 and status(alice, "/admin") == 404

again = Browser()
o = again.json("/auth/login/options")
checks["login_with_passkey"] = again.json("/auth/login/verify", alice_key.get(o)).get("ok") is True
o = again.json("/auth/login/options")
checks["login_twice_counter_ok"] = again.json("/auth/login/verify", alice_key.get(o)).get("ok") is True
# A second tap or tab starts another ceremony; the first one must still verify.
twice = Browser()
o1 = twice.json("/auth/login/options"); twice.json("/auth/login/options")
checks["overlapping_signins_ok"] = twice.json("/auth/login/verify", alice_key.get(o1)).get("ok") is True
def reply(b, path, body):
    try:
        return b.open(path, body, "POST").read().decode()
    except urllib.error.HTTPError as e:
        return e.read().decode()
checks["broken_signin_returns_json"] = all("error" in json.loads(reply(Browser(), p, {"id": "x", "response": {"clientDataJSON": "!!"}}))
                                           for p in ("/auth/login/verify", "/auth/register/verify"))
o = Browser().json("/auth/login/options")
checks["unknown_passkey_rejected"] = "error" in Browser().json("/auth/login/verify", Authenticator().get(o))

leads = []


def answer(html):
    return "".join(json.loads(m) for m in re.findall(r"<script>T\((\".*?\")\)</script>", html))


for q in ["what is the capital of australia", "golden gate bridge",
          "how old was the ceo of amd when nvidia was founded"] * 2:
    ttfb, first, total, html = search(again, q)
    rows.append({"q": q, "ttfb": round(ttfb, 3), "first_token": round(first or -1, 3), "total": round(total, 3),
                 "inline_images": answer(html).count("](img:")})
    print(rows[-1], flush=True)
    if q == "golden gate bridge":
        bridge = html
    if "amd" in q:
        leads.append(re.split(r"(?<=[.!?])\s", answer(html).strip(), 1)[0].lower())
plain = answer(search(again, "what is 17 times 23")[3])

chat_id = re.search(r'"id":"(\w+)"', bridge).group(1)
checks["answer_streams"] = "<script>T(" in bridge and "<script>D(" in bridge
checks["images_for_visual_query"] = "](img:" in answer(bridge)
# Needs two searched facts (Lisa Su born Nov 1969, Nvidia founded Apr 1993); the answer does not change over time.
checks["multi_step_answer_leads_with_23"] = all(re.search(r"\b23\b", lead) for lead in leads)
checks["no_images_for_plain_fact"] = "391" in plain and "](img:" not in plain
NAV_LINE = r"^\s*\[[^\]]+\]\((https?://\S+)\)\s*(?:\[\d+(?:,\s*\d+)*\])?\s*$"
nav = answer(search(again, "github")[3]).strip().split("\n")[0]
checks["nav_query_leads_with_link"] = bool(re.match(NAV_LINE, nav)) and "github.com" in nav
checks["plain_question_no_link"] = not re.match(NAV_LINE, plain.strip().split("\n")[0])
time.sleep(1.5)
checks["chat_in_own_sidebar"] = chat_id in alice.chat_ids()
checks["chat_not_in_other_sidebar"] = chat_id not in bob.chat_ids()
BOB = f"e2e-bob-{RUN}@example.com"
ADMIN.json("/api/admin/limit", {"email": BOB, "daily": 0})
capped = search(bob, "what is the tallest mountain")[3]
checks["daily_limit_stops_questions"] = "daily limit" in capped and "<script>T(" not in capped
ADMIN.json("/api/admin/limit", {"email": BOB, "daily": None})
checks["limit_restored"] = "<script>T(" in search(bob, "what is 2 plus 2")[3]
find = lambda who, q: [c["id"] for c in json.load(who.open("/api/chats?q=" + urllib.parse.quote(q)))]
word = max(re.findall(r"[A-Za-z]{7,}", answer(bridge)), key=len)
checks["search_by_title_prefix"] = chat_id in find(alice, "golden gat")
checks["search_by_answer_word"] = chat_id in find(alice, word)
checks["search_only_own_chats"] = chat_id not in find(bob, "golden gat")
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

time.sleep(1)
stored_chat = alice.text(f"/c/{chat_id}")
checks["followup_cannot_rewrite_history"] = "It is a suspension bridge in San Francisco." not in stored_chat and "how long is it?" in stored_chat

def chat_state(cid):
    return json.loads(re.search(r"const S=(\{.*?\});", alice.text(f"/c/{cid}")).group(1))
st = chat_state(chat_id)
first_answer = st["msgs"][1]
checks["followups_saved_not_shown"] = len(first_answer.get("followups") or []) == 3 and ":::" not in first_answer["text"] and "<script>F(" in bridge
checks["answers_keep_results_and_model"] = all(m.get("results") and m.get("model") == "lite" for m in st["msgs"] if m["role"] == "model")
# Rerun only the first answer: it is replaced in place, later turns stay.
later = st["msgs"][3]["text"]
alice.open(f"/api/chats/{chat_id}", {"title": "x", "msgs": st["msgs"][:1], "cid": "e2e", "replace": True}, "POST").read()
time.sleep(1.5)
st2 = chat_state(chat_id)
checks["rerun_one_answer_in_place"] = len(st2["msgs"]) == 4 and st2["msgs"][3]["text"] == later and st2["msgs"][1]["role"] == "model"
one = alice.json(f"/api/chats/{chat_id}/share", {"n": 4, "at": 3})
one_page = Browser(access_key=False).text("/s/" + one["id"])
checks["share_one_answer"] = one_page.count('"role":"user"') == 1 and "how long is it?" in one_page and '"results"' not in one_page
link = alice.json(f"/api/chats/{chat_id}/share", {"n": 2})["url"]
share_path = "/s/" + link.rsplit("/", 1)[1]
public = Browser(access_key=False).text(share_path)
checks["share_link_public"] = link.startswith(BASE) and "golden gate" in public.lower() and "](img:" in public
checks["share_page_read_only"] = 'id="side"' not in public and "<textarea" not in public and "og:title" in public
checks["share_card_tags"] = 'name="twitter:card" content="summary_large_image"' in public and f'content="{link}/card.png"' in public
card = Browser(access_key=False).open(share_path + "/card.png")
png = card.read()
checks["share_card_png"] = card.headers["content-type"] == "image/png" and png[:8] == b"\x89PNG\r\n\x1a\n" and int.from_bytes(png[16:20], "big") == 1200
share_id = share_path.rsplit("/", 1)[1]
checks["chat_page_lists_links"] = f'"shares":[{{"id":"{share_id}"' in alice.text(f"/c/{chat_id}")
checks["same_content_reuses_link"] = alice.json(f"/api/chats/{chat_id}/share", {"n": 2})["id"] == share_id
extra = alice.json(f"/api/chats/{chat_id}/share", {"n": 4, "at": 1})["id"]
checks["different_content_new_link"] = extra != share_id
checks["bob_cannot_delete_link"] = bob.open(f"/api/chats/{chat_id}/shares/{extra}", method="DELETE").getcode() == 204 and \
    "golden gate" in Browser(access_key=False).text(f"/s/{extra}").lower()
alice.open(f"/api/chats/{chat_id}/shares/{extra}", method="DELETE").read()
time.sleep(1)
try:
    Browser(access_key=False).open(f"/s/{extra}")
    checks["delete_one_link"] = False
except urllib.error.HTTPError as e:
    checks["delete_one_link"] = e.code == 404 and f'"id":"{extra}"' not in alice.text(f"/c/{chat_id}")
anon = Browser().open(f"/api/chats/{chat_id}/share", {"n": 2}, "POST").read().decode()
checks["share_needs_account"] = '"url"' not in anon
try:
    Browser(access_key=False).open("/s/doesnotexist")
    checks["unknown_share_404"] = False
except urllib.error.HTTPError as e:
    checks["unknown_share_404"] = e.code == 404

# Rerun the only question: the new answer replaces the old one.
small = search(alice, "what is the capital of australia")[3]
small_id = re.search(r'"id":"(\w+)"', small).group(1)
time.sleep(1.5)
rerun = alice.open(f"/api/chats/{small_id}", {"title": "capital", "msgs": [{"role": "user", "text": "what is the capital of australia"}],
                                               "cid": "e2e"}, "POST").read().decode()
time.sleep(1.5)
saved = alice.text(f"/c/{small_id}")
checks["rerun_answers"] = "canberra" in rerun.lower() and "\u0000D" in rerun
checks["rerun_replaces_answer"] = saved.count('"role":"model"') == 1

out = Browser()
out.cookies = dict(alice.cookies)
out.open("/auth/logout")
checks["logout"] = "Sign in with passkey" in out.text("/")
osd = Browser(access_key=False).open("/opensearch.xml")
checks["opensearch_inline"] = "{searchTerms}" in osd.read().decode() and osd.headers["content-type"].startswith("text/xml")

for cid in alice.chat_ids():
    alice.open(f"/api/chats/{cid}", method="DELETE").read()
checks["delete"] = alice.chat_ids() == []
time.sleep(1)
try:
    Browser(access_key=False).open(share_path)
    checks["deleting_chat_removes_links"] = False
except urllib.error.HTTPError as e:
    checks["deleting_chat_removes_links"] = e.code == 404

avg = {k: round(statistics.mean(r[k] for r in rows), 3) for k in ("ttfb", "first_token", "total")}
json.dump({"base": BASE, "runs": rows, "avg": avg, "followup_first_token": round(followup_ft, 3), "checks": checks},
          open("e2e-result.json", "w"), indent=1)
print("avg", avg, "follow-up first token", round(followup_ft, 3))
print(json.dumps(checks, indent=1))
sys.exit(0 if all(checks.values()) else 1)
