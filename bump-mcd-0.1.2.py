#!/usr/bin/env python3
"""Bump muse-code-desktop to v0.1.2 for the issues #1/#2 release.

Asserts the current version is 0.1.1 in BOTH package.json and
src-tauri/tauri.conf.json (Tauri bakes the conf version into the installer
filename), then sets both to 0.1.2. Fails loudly on anything unexpected.

Usage: save as bump-mcd-0.1.2.py in the repo root
(C:\\Users\\Brian\\muse-code-desktop\\) and run:
    python bump-mcd-0.1.2.py
Then:  git add -A && git commit -m "release: v0.1.2" && git push
Idempotent: re-running skips files already at 0.1.2.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TARGET = "0.1.2"
EXPECTED = "0.1.1"
FILES = [ROOT / "package.json", ROOT / "src-tauri/tauri.conf.json"]

if not (ROOT / "src-tauri" / "tauri.conf.json").exists():
    sys.exit("FAIL: run this script from the muse-code-desktop repo root.")

applied, skipped = [], []
for f in FILES:
    if not f.exists():
        sys.exit(f"FAIL: {f.name} not found")
    data = json.loads(f.read_text(encoding="utf-8"))
    cur = data.get("version")
    if cur == TARGET:
        skipped.append(f"{f.name} (already {TARGET})")
        continue
    if cur != EXPECTED:
        sys.exit(
            f"FAIL: {f.name} version is {cur!r}, expected {EXPECTED!r}. "
            "Fix it by hand before bumping."
        )
    data["version"] = TARGET
    f.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    applied.append(f"{f.name}: {EXPECTED} -> {TARGET}")

print(f"\napplied: {len(applied)}, skipped: {len(skipped)}")
for s in skipped:
    print(f"  SKIP {s}")
for a in applied:
    print(f"  OK   {a}")
