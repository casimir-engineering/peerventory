#!/usr/bin/env bash
#
# Cut a Peerventory release: web bundle -> signed APK -> GitHub release.
#
# Releases are cut from the maintainer's machine on purpose. The upload key
# lives in secrets/release.keystore (gitignored, never in CI): every APK the
# updater offers must be signed with the same key, or Android refuses the
# update as a different app. There is deliberately no CI signing job.
#
#   scripts/release.sh              # release the version in app/package.json
#   scripts/release.sh 1.2.0        # bump to 1.2.0 first, then release
#   scripts/release.sh --apk-only   # build+sign locally, no GitHub release
#   scripts/release.sh --dry-run    # everything except `gh release create`
#
# The keystore password is read from PV_KEYSTORE_PASS, or from
# secrets/keystore.pass (gitignored). It is never written into this file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- configuration ----------------------------------------------------------
PROD_ORIGIN="${PV_PROD_ORIGIN:-https://inventory.example.com}"
JAVA_HOME_DIR="${PV_JAVA_HOME:-/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home}"
ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS="${PV_BUILD_TOOLS:-$ANDROID_SDK/build-tools/35.0.0}"
KEYSTORE="$ROOT/secrets/release.keystore"
KEY_ALIAS="${PV_KEY_ALIAS:-inventory}"
APK_OUT="$ROOT/inventory-release.apk"
REPO="casimir-engineering/peerventory"

apk_only=0
dry_run=0
new_version=""
for arg in "$@"; do
  case "$arg" in
    --apk-only) apk_only=1 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) new_version="$arg" ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- preflight --------------------------------------------------------------
step "Preflight"
[ -f "$KEYSTORE" ] || die "missing $KEYSTORE — the release key is not on this machine"
[ -d "$JAVA_HOME_DIR" ] || die "JDK 21 not found at $JAVA_HOME_DIR (brew install openjdk@21)"
[ -x "$BUILD_TOOLS/zipalign" ] || die "zipalign not found in $BUILD_TOOLS"
command -v gh >/dev/null || die "gh CLI is required"

KEYSTORE_PASS="${PV_KEYSTORE_PASS:-}"
if [ -z "$KEYSTORE_PASS" ] && [ -f "$ROOT/secrets/keystore.pass" ]; then
  KEYSTORE_PASS="$(tr -d '\n' < "$ROOT/secrets/keystore.pass")"
fi
[ -n "$KEYSTORE_PASS" ] || die "set PV_KEYSTORE_PASS or create secrets/keystore.pass"

bash scripts/secret-scan.sh || die "secret scan failed — refusing to publish"

if [ -n "$new_version" ]; then
  step "Bumping version to $new_version"
  ( cd app && npm version "$new_version" --no-git-tag-version --allow-same-version >/dev/null )
fi

VERSION="$(node -p "require('$ROOT/app/package.json').version")"
TAG="v$VERSION"
step "Releasing $TAG"

if gh release view "$TAG" -R "$REPO" >/dev/null 2>&1; then
  die "$TAG already exists — bump the version first (scripts/release.sh <version>)"
fi

# --- web bundle -------------------------------------------------------------
step "Building web bundle (origin $PROD_ORIGIN)"
( cd app && VITE_SERVER_ORIGIN="$PROD_ORIGIN" npm run build )

# --- APK --------------------------------------------------------------------
step "Syncing Capacitor and assembling the release APK"
export JAVA_HOME="$JAVA_HOME_DIR"
export ANDROID_HOME="$ANDROID_SDK"
( cd app && npx cap sync android )
( cd app/android && ./gradlew assembleRelease --no-daemon )

UNSIGNED="$ROOT/app/android/app/build/outputs/apk/release/app-release-unsigned.apk"
[ -f "$UNSIGNED" ] || die "gradle produced no APK at $UNSIGNED"

step "Aligning and signing"
"$BUILD_TOOLS/zipalign" -f -p 4 "$UNSIGNED" /tmp/inv-aligned.apk
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-pass "pass:$KEYSTORE_PASS" \
  --ks-key-alias "$KEY_ALIAS" \
  --out "$APK_OUT" \
  /tmp/inv-aligned.apk
"$BUILD_TOOLS/apksigner" verify --print-certs "$APK_OUT" | head -4

# versionName inside the APK must match the tag, or the updater loops forever
# offering an "update" that installs the same version.
if [ -x "$BUILD_TOOLS/aapt2" ]; then
  apk_version="$("$BUILD_TOOLS/aapt2" dump badging "$APK_OUT" 2>/dev/null |
    sed -n "s/.*versionName='\([^']*\)'.*/\1/p" | head -1)"
  if [ -n "$apk_version" ] && [ "$apk_version" != "$VERSION" ]; then
    die "APK versionName $apk_version != package.json $VERSION"
  fi
fi

printf '\nSigned APK: %s (%s)\n' "$APK_OUT" "$(du -h "$APK_OUT" | cut -f1)"
if [ "$apk_only" -eq 1 ]; then exit 0; fi

# --- GitHub release ---------------------------------------------------------
step "Creating GitHub release $TAG"
NOTES_FILE="${PV_NOTES_FILE:-}"
if [ -z "$NOTES_FILE" ]; then
  NOTES_FILE="$(mktemp)"
  {
    echo "Install: download **inventory-release.apk** below and open it on your phone."
    echo
    echo "Changes since the previous release:"
    echo
    prev="$(gh release list -R "$REPO" --limit 1 --json tagName -q '.[0].tagName' 2>/dev/null || true)"
    # `gh release create` tags on the server, so the previous tag is usually
    # absent locally. Fetch it, and fall back to the whole history rather than
    # dying on an unknown revision.
    if [ -n "$prev" ]; then
      git fetch --quiet --tags origin >/dev/null 2>&1 || true
      git rev-parse -q --verify "${prev}^{commit}" >/dev/null 2>&1 || prev=""
    fi
    git log ${prev:+"$prev..HEAD"} --no-merges --pretty='- %s' | head -40
  } > "$NOTES_FILE"
fi

if [ "$dry_run" -eq 1 ]; then
  step "Dry run — release notes that would be published"
  cat "$NOTES_FILE"
  exit 0
fi

gh release create "$TAG" "$APK_OUT" \
  -R "$REPO" \
  --title "Peerventory $VERSION" \
  --notes-file "$NOTES_FILE"

step "Done"
gh release view "$TAG" -R "$REPO" --json tagName,assets -q \
  '"\(.tagName): " + ([.assets[] | .name + " (" + (.size|tostring) + "B)"] | join(", "))'
echo "Commit the version bump: git commit -am 'Release $VERSION'"
