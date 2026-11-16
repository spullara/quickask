"""App Store Connect API access with the key in ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH. Needs the cryptography package."""
import base64, json, os, ssl, sys, time, urllib.parse, urllib.request
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

kid, iss = os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"]
key = serialization.load_pem_private_key(open(os.environ["ASC_KEY_PATH"], "rb").read(), None)
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem") if os.path.exists("/etc/ssl/cert.pem") else None
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")


def get(path):
    return send("GET", path)


def send(method, path, body=None):
    now = int(time.time())
    head = b64(json.dumps({"alg": "ES256", "kid": kid, "typ": "JWT"}).encode()) + b"." + \
        b64(json.dumps({"iss": iss, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}).encode())
    r, s = utils.decode_dss_signature(key.sign(head, ec.ECDSA(hashes.SHA256())))
    jwt = (head + b"." + b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))).decode()
    req = urllib.request.Request("https://api.appstoreconnect.apple.com" + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {jwt}", "Content-Type": "application/json"})
    body = urllib.request.urlopen(req, context=CTX, timeout=30).read()
    return json.loads(body) if body else None  # 204 No Content for relationship changes


