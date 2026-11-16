"""Wait for App Store Connect to accept or reject the latest upload of a build, and print why it was rejected.
Usage: python3 upload_status.py BUNDLE_ID BUILD_NUMBER (ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH in the environment).
Exit code 0 when the build is valid, 1 when it was rejected or the check timed out. Needs the cryptography package."""
import sys, time, urllib.parse
from asc import get

bundle, build = sys.argv[1], sys.argv[2]
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
