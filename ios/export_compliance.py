"""Answer App Store Connect's export compliance question for an uploaded build: Quisk uses only standard HTTPS.
(Builds made after Info.plist has ITSAppUsesNonExemptEncryption = NO do not need this.)
Usage: python3 export_compliance.py BUNDLE_ID BUILD_NUMBER (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in the environment)."""
import sys, urllib.parse
from asc import get, send

bundle, number = sys.argv[1:3]
app = get("/v1/apps?filter[bundleId]=" + urllib.parse.quote(bundle))["data"][0]["id"]
build = get(f"/v1/builds?filter[app]={app}&filter[version]={number}")["data"][0]["id"]
r = send("PATCH", f"/v1/builds/{build}", {"data": {"type": "builds", "id": build, "attributes": {"usesNonExemptEncryption": False}}})
print(number, "usesNonExemptEncryption =", r["data"]["attributes"]["usesNonExemptEncryption"])
