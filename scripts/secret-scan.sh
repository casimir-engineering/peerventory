#!/usr/bin/env bash
# Fails if anything that must stay on the release machine reached tracked files.
# Runs in CI on every push and locally from .githooks/pre-commit.
#
# Placeholders in source and tests ("sk-ant-...", "sk-ant-FAKE-...") are legitimate,
# so the key patterns match only strings long enough to be a real credential.
set -uo pipefail

cd "$(git rev-parse --show-toplevel)"

status=0
report() {
  status=1
  echo "SECRET SCAN FAILURE: $1" >&2
  shift
  printf '%s\n' "$@" >&2
}

# Paths excluded from content scanning: vendored OCR/wasm blobs and lockfiles are
# megabytes of base64 that trip every entropy-style pattern.
excludes=(':!app/public/ocr' ':!*package-lock.json' ':!scripts/secret-scan.sh')

scan_content() {
  local label="$1" pattern="$2"
  local hits
  hits=$(git grep -I -n -E "$pattern" -- . "${excludes[@]}" 2>/dev/null)
  [ -n "$hits" ] && report "$label" "$hits"
}

# Real Anthropic keys are sk-ant-<kind>NN-<~95 chars>; placeholders are far shorter.
scan_content "Anthropic API key" 'sk-ant-[a-z]*[0-9]{2}-[A-Za-z0-9_-]{40,}'
scan_content "GitHub token" '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}'
scan_content "private key block" 'BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
scan_content "AWS access key" 'AKIA[0-9A-Z]{16}'
scan_content "Android signing password" '(storePassword|keyPassword|--ks-pass|--key-pass)[= ]+[^$"'"'"' ]'
# The deployment host is deliberately not public; docs use inventory.example.com.
scan_content "private deployment hostname" 'meerkat\.orgabots\.com'

# Files that must never be tracked, whatever .gitignore currently says.
forbidden=$(git ls-files | grep -E '(^|/)secrets/|\.(jks|keystore|apk|idsig|p12|pem)$|(^|/)\.env(\.|$)' || true)
[ -n "$forbidden" ] && report "file that must stay local is tracked" "$forbidden"

if [ "$status" -eq 0 ]; then
  echo "secret scan: clean"
fi
exit "$status"
