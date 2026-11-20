"""Build a source ZIP using an allowlist. No settings, keys, outputs or .git data."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import re

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
files = [
    "manifest.json", "package.json", "index.js", "standalone-ui.mjs", "monitoring.mjs", "monitoring-cost.mjs",
    "vault.mjs", "pricing.mjs", "local-usage.mjs", "credit-period.mjs", "floating-ui.mjs", "price-parser.mjs", "prices.json", "style.css",
    "README.md", "LICENSE", ".gitignore", "docs/panel.png", "docs/floating.png",
    "scripts/update-prices.mjs", "scripts/package-release.py",
    "tests/standalone-monitoring.test.mjs", "tests/standalone-credit.test.mjs", "tests/standalone-pricing.test.mjs", "tests/standalone-ui-smoke.mjs",
]
for name in [f for f in files if not f.endswith(".png")]:
    content = (root / name).read_text(encoding="utf-8")
    # Public code may refer to key field names; it must never contain an actual PEM key.
    if re.search(r"-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{32,}", content):
        raise SystemExit(f"Refusing to package a private key in {name}")
out = root / "outputs" / f"Vertex-Usage-{version}.zip"
out.parent.mkdir(exist_ok=True)
with ZipFile(out, "w", ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, f"ST-Vertex-Usage/{name}")
print(f"Created {out.name}: {len(files)} source files; no local settings or keys.")
