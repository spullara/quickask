"""Send an uploaded build to external TestFlight testers: set its "What to Test" note, add it to every external
beta group, and submit it to Beta App Review (later builds of an approved app are usually approved quickly).
Usage: python3 distribute.py BUNDLE_ID BUILD_NUMBER "What to Test" (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in the environment)."""
import sys, time, urllib.error, urllib.parse
from asc import get, send

bundle, number, notes = sys.argv[1:4]
app = get("/v1/apps?filter[bundleId]=" + urllib.parse.quote(bundle))["data"][0]["id"]
build = get(f"/v1/builds?filter[app]={app}&filter[version]={number}")["data"][0]["id"]

locs = get(f"/v1/builds/{build}/betaBuildLocalizations")["data"]
if locs:
    send("PATCH", f"/v1/betaBuildLocalizations/{locs[0]['id']}", {"data": {"type": "betaBuildLocalizations", "id": locs[0]["id"], "attributes": {"whatsNew": notes}}})
else:
    send("POST", "/v1/betaBuildLocalizations", {"data": {"type": "betaBuildLocalizations", "attributes": {"locale": "en-US", "whatsNew": notes},
                                                        "relationships": {"build": {"data": {"type": "builds", "id": build}}}}})
print(f"build {number}: What to Test = {notes!r}")

groups = [g for g in get(f"/v1/apps/{app}/betaGroups?limit=50")["data"] if not g["attributes"]["isInternalGroup"]]
for g in groups:
    # A build that has only just finished processing can 404 here for a minute or two.
    for attempt in range(10):
        try:
            send("POST", f"/v1/betaGroups/{g['id']}/relationships/builds", {"data": [{"type": "builds", "id": build}]})
            print("added to group", g["attributes"]["name"])
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode()[:300]
            if attempt == 9:
                sys.exit(f"could not add to group {g['attributes']['name']}: {e.code} {detail}")
            print(f"group {g['attributes']['name']}: {e.code}, retrying ({detail[:120]})", flush=True)
            time.sleep(30)

try:
    r = send("POST", "/v1/betaAppReviewSubmissions", {"data": {"type": "betaAppReviewSubmissions",
                                                               "relationships": {"build": {"data": {"type": "builds", "id": build}}}}})
    print("beta review:", r["data"]["attributes"]["betaReviewState"])
except urllib.error.HTTPError as e:
    print("beta review submission:", e.code, e.read().decode()[:300])
