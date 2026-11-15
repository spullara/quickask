"""Wait for App Store Connect to accept or reject the latest upload of a build, and print why it was rejected.
Usage: python3 upload_status.py BUNDLE_ID BUILD_NUMBER (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in the environment).
Exit code 0 when the build is valid, 1 when it was rejected or the check timed out. Needs the cryptography package."""
import base64, json, os, ssl, sys, time, urllib.parse, urllib.request
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils

bundle, build = sys.argv[1], sys.argv[2]
kid, iss = os.environ["ASC_KEY_ID"], os.environ["ASC_ISSUER_ID"]
key = serialization.load_pem_private_key(open(os.environ["ASC_KEY_PATH"], "rb").read(), None)
CTX = ssl.create_default_context(cafile="/etc/ssl/cert.pem") if os.path.exists("/etc/ssl/cert.pem") else None
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")


def get(path):
    now = int(time.time())
    head = b64(json.dumps({"alg": "ES256", "kid": kid, "typ": "JWT"}).encode()) + b"." + \
        b64(json.dumps({"iss": iss, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}).encode())
    r, s = utils.decode_dss_signature(key.sign(head, ec.ECDSA(hashes.SHA256())))
    jwt = (head + b"." + b64(r.to_bytes(32, "big") + s.to_bytes(32, "big"))).decode()
    req = urllib.request.Request("https://api.appstoreconnect.apple.com" + path, headers={"Authorization": f"Bearer {jwt}"})
    return json.load(urllib.request.urlopen(req, context=CTX, timeout=30))


app = get("/v1/apps?filter[bundleId]=" + urllib.parse.quote(bundle))["data"][0]["id"]
for _ in range(60):  # up to 10 minutes
    uploads = [u["attributes"] for u in get(f"/v1/apps/{app}/buildUploads?limit=5")["data"] if u["attributes"]["cfBundleVersion"] == build]
    state = uploads[0]["state"] if uploads else None
    if state and state["state"] == "FAILED":
        print(f"App Store Connect rejected build {build}:")
        for e in state["errors"]:
            print(f"  {e['code']}: {e['description']}")
        sys.exit(1)
    if state and state["state"] == "COMPLETE":
        print(f"Build {build} is valid and in TestFlight.")
        sys.exit(0)
    time.sleep(10)
print(f"Build {build} is still processing; check App Store Connect later.")
sys.exit(1)
