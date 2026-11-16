"""Set the sign-in details Apple's Beta App Review uses (App Store Connect → TestFlight → Test Information).
Usage: python3 beta_review_details.py BUNDLE_ID EMAIL CODE (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in the environment)."""
import json, sys, urllib.parse
from asc import get, send

bundle, email, code = sys.argv[1:4]
app = get("/v1/apps?filter[bundleId]=" + urllib.parse.quote(bundle))["data"][0]["id"]
notes = ("Quisk needs an account. On the first screen tap Sign in. In the sign-in page, tap \"Sign in with a code\" "
         "(below the email field), enter the email address and the code above as the password, and tap Sign in. "
         "Then ask any question. To try voice: say \"Quisk\" while the app is open, or tap the microphone.")
r = send("PATCH", f"/v1/betaAppReviewDetails/{app}", {"data": {"type": "betaAppReviewDetails", "id": app, "attributes": {
    "demoAccountRequired": True, "demoAccountName": email, "demoAccountPassword": code, "notes": notes}}})
a = r["data"]["attributes"]
print(json.dumps({k: a.get(k) for k in ("demoAccountRequired", "demoAccountName", "notes")}))
