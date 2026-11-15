#!/usr/bin/env bash
# Build wheels/dizione-*.whl: the dizione phonemizer (tiny-voca's text front end) with its data inside the package,
# so the Python Worker can install it from a prebuilt wheel. Needs git, curl and uv.
set -euo pipefail
cd "$(dirname "$0")"
REV="${DIZIONE_REV:-main}"
work="$(mktemp -d)"
git clone -q --depth 1 --branch "$REV" https://github.com/n4ze3m/dizione.git "$work/dizione"
pkg="$(dirname "$(find "$work/dizione" -path '*/dizione/__init__.py' -not -path '*/tests/*' | head -1)")"
mkdir -p "$work/build/dizione/built"
cp -R "$pkg"/. "$work/build/dizione/"
rm -rf "$work/build/dizione/__pycache__"
BASE=https://huggingface.co/n4ze3m/tiny-voca/resolve/main/phonemizer
for f in lexicon.tsv align.json g2p.json g2p.npz homographs.json lexicon.json; do curl -fsSL -o "$work/build/dizione/built/$f" "$BASE/$f"; done
version="$(grep -m1 -oE 'VERSION = "[^"]+"' "$pkg/__init__.py" | cut -d'"' -f2 || true)"
cat > "$work/build/pyproject.toml" <<TOML
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"
[project]
name = "dizione"
version = "${version:-0.0.0}"
dependencies = ["numpy"]
[tool.setuptools]
packages = ["dizione"]
[tool.setuptools.package-data]
dizione = ["data/*", "built/*"]
TOML
mkdir -p wheels && rm -f wheels/*.whl
uv build -q --wheel --out-dir wheels "$work/build"
rm -rf "$work"
ls -l wheels
