"""Check publishable Git files for common credential signatures; never print values."""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
patterns = {
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "GitHub token": re.compile(rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})"),
    "OpenAI key": re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}"),
    "AWS access ID": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "Google API key": re.compile(rb"\bAIza[0-9A-Za-z_-]{35}\b"),
}
raw = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT)
failures = []
count = 0
for name in sorted(set(raw.decode().strip("\0").split("\0"))):
    path = ROOT / name
    if not path.is_file():
        continue
    if path.name.startswith(".env") and path.name != ".env.example":
        failures.append((name, "environment file must not be committed"))
    content = path.read_bytes()
    if b"\0" in content[:4096]:
        continue
    count += 1
    for label, pattern in patterns.items():
        if pattern.search(content):
            failures.append((name, label))
if failures:
    for name, label in failures:
        print(f"Credential review required: {name} ({label})", file=sys.stderr)
    raise SystemExit(1)
print(f"No credential signatures found in {count} publishable text files; ignored local env files are excluded.")
