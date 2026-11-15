#!/usr/bin/env bash
# Put the tiny-voca voice model (21 MB, Apache-2.0) into the iOS and Android apps, which ship it in the download.
# Run once before building the apps. The file is not stored in git.
set -euo pipefail
cd "$(dirname "$0")/.."
URL=https://huggingface.co/n4ze3m/tiny-voca/resolve/main/onnx/model.onnx
SHA=fe6d918791a15b82e37465981d7f27a070e46b46635e5a3482fc8dff87a1ae46
tmp="$(mktemp)"
curl -fsSL -o "$tmp" "$URL"
echo "$SHA  $tmp" | shasum -a 256 -c - >/dev/null || { echo "tiny-voca model checksum mismatch" >&2; exit 1; }
mkdir -p ios/Quisk/Voice android/app/src/main/assets
cp "$tmp" ios/Quisk/Voice/tiny-voca.onnx
cp "$tmp" android/app/src/main/assets/tiny-voca.onnx
rm -f "$tmp"
echo "tiny-voca model in ios/Quisk/Voice and android/app/src/main/assets"
