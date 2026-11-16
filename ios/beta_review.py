"""Beta App Review state of the builds sent to external TestFlight testers. Prints one JSON line:
{"build": the first build sent for review, "state": its review state, "builds": {build: state} for recent builds}.
Usage: python3 beta_review.py BUNDLE_ID (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in the environment)."""
import json, sys, urllib.parse
from asc import get

app = get("/v1/apps?filter[bundleId]=" + urllib.parse.quote(sys.argv[1]))["data"][0]["id"]
d = get(f"/v1/builds?filter[app]={app}&sort=-uploadedDate&limit=50&include=buildBetaDetail,betaAppReviewSubmission")
inc = {(x["type"], x["id"]): x["attributes"] for x in d.get("included", [])}
builds = {}
for b in d["data"]:
    rel = b["relationships"]
    sub = (rel.get("betaAppReviewSubmission") or {}).get("data")
    detail = (rel.get("buildBetaDetail") or {}).get("data")
    state = inc.get((sub["type"], sub["id"]), {}).get("betaReviewState") if sub else None
    builds[b["attributes"]["version"]] = state or (inc.get((detail["type"], detail["id"]), {}).get("externalBuildState") if detail else None)
reviewed = [n for n, s in builds.items() if s and s not in ("READY_FOR_BETA_SUBMISSION", "MISSING_EXPORT_COMPLIANCE", "PROCESSING")]
first = min(reviewed, key=int) if reviewed else None
print(json.dumps({"build": first, "state": builds.get(first), "builds": builds}))
