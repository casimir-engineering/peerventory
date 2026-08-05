#!/usr/bin/env bash
#
# Regenerate every app icon from design/icon-source.png (ImageMagick 7).
#
#   scripts/gen-icons.sh            # write all icons
#   scripts/gen-icons.sh --preview  # also build design/icon-preview.png
#
# The source is a 1024x1024 flat icon: an amber "P" of stacked boxes on a
# near-black rounded square. Two derivatives are cut from it and everything
# else is a resize of one of the two:
#
#   flat.png   the whole tile with the pure-black outside-the-corners area
#              turned transparent, so the rounded silhouette survives on a
#              light background (favicons, PWA "any" icons, legacy launcher).
#   motif.png  just the boxes on transparency, background subtracted. Used
#              wherever the platform draws its own background and mask:
#              Android adaptive/round/monochrome layers, maskable PWA icon.
#
# Sizing rule for every masked context: a circular mask of diameter D can only
# contain the motif's bounding box if its height H satisfies 0.6092*H <= D/2
# (the 0.6092 is half the bbox diagonal per unit of height for this artwork).
# The adaptive foreground therefore uses H = 0.50 * canvas, which is 75% of the
# 66.7% viewport Android actually shows -- full-looking, but the corner boxes
# still clear a circle mask.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="$ROOT/design/icon-source.png"
RES="$ROOT/app/android/app/src/main/res"
PUB="$ROOT/app/public"
BG="#0d0e12"          # adaptive/maskable background, matches the source tile
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v magick >/dev/null || { echo "error: ImageMagick 7 (magick) required" >&2; exit 1; }
[ -f "$SRC" ] || { echo "error: missing $SRC" >&2; exit 1; }

# --- derivatives ------------------------------------------------------------
# flat: alpha from the source's own luminance. The area outside the rounded
# square is pure black (0) while the tile background never drops below 10/255,
# so a level between those two cuts the corners off with clean antialiasing.
magick "$SRC" \
  \( +clone -colorspace Gray -level '0.5%,3.6%' \) \
  -alpha off -compose CopyOpacity -composite \
  "$WORK/flat.png"

# motif: alpha from the per-pixel difference against the tile background, then
# cropped to the boxes. This drops the background *and* the enclosed counter of
# the "P" and the box handles, which is what a transparent layer wants.
magick "$SRC" \
  \( +clone -fill "srgb(10,12,18)" -colorize 100 \) \
  -compose Difference -composite \
  -colorspace Gray -level '2.5%,9%' \
  "$WORK/alpha.png"
magick "$SRC" "$WORK/alpha.png" -alpha off -compose CopyOpacity -composite \
  -crop 523x751+268+125 +repage "$WORK/motif.png"

# monochrome silhouette for Android 13 themed icons: the same alpha, filled
# white. Android tints the alpha channel and ignores the colour.
magick -size 523x751 xc:white \
  \( "$WORK/motif.png" -alpha extract \) \
  -alpha off -compose CopyOpacity -composite "$WORK/motif-white.png"

# place_motif <src-motif> <canvas> <height-fraction> <background> <out>
place_motif() {
  local motif="$1" canvas="$2" frac="$3" bg="$4" out="$5"
  local h
  h="$(printf '%.0f' "$(echo "$canvas * $frac" | bc -l)")"
  magick -size "${canvas}x${canvas}" "xc:${bg}" \
    \( "$motif" -resize "x${h}" \) \
    -gravity center -compose Over -composite \
    -depth 8 -define png:color-type=6 "$out"
}

# --- Android: legacy square launcher icons ----------------------------------
echo "==> Android mipmaps"
# ic_launcher_round has no platform-drawn background, so bake the disc here.
# Built at full size and downsampled, which antialiases the rim properly.
magick -size 1024x1024 xc:none -fill "$BG" -draw 'circle 512,512 512,0' \
  \( "$WORK/motif.png" -resize x768 \) -gravity center -composite \
  "$WORK/round.png"

for spec in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d="${spec%%:*}"; s="${spec##*:}"
  mkdir -p "$RES/mipmap-$d"
  magick "$WORK/flat.png" -resize "${s}x${s}" -depth 8 -define png:color-type=6 \
    "$RES/mipmap-$d/ic_launcher.png"
  magick "$WORK/round.png" -resize "${s}x${s}" -depth 8 -define png:color-type=6 \
    "$RES/mipmap-$d/ic_launcher_round.png"
done

# --- Android: adaptive layers (108dp canvas, 72dp visible viewport) ---------
for spec in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  d="${spec%%:*}"; s="${spec##*:}"
  place_motif "$WORK/motif.png" "$s" 0.50 none "$RES/mipmap-$d/ic_launcher_foreground.png"
  place_motif "$WORK/motif-white.png" "$s" 0.50 none "$RES/mipmap-$d/ic_launcher_monochrome.png"
done

# --- Android: splash --------------------------------------------------------
echo "==> Android splash"
for f in "$RES"/drawable*/splash.png; do
  read -r w h < <(magick identify -format '%w %h\n' "$f")
  short=$(( w < h ? w : h ))
  mh="$(printf '%.0f' "$(echo "$short * 0.30" | bc -l)")"
  magick -size "${w}x${h}" "xc:${BG}" \
    \( "$WORK/motif.png" -resize "x${mh}" \) \
    -gravity center -composite -depth 8 "$f"
done

# --- PWA / web --------------------------------------------------------------
echo "==> PWA icons"
mkdir -p "$PUB"
magick "$WORK/flat.png" -resize 192x192 -depth 8 -define png:color-type=6 "$PUB/icon-192.png"
magick "$WORK/flat.png" -resize 512x512 -depth 8 -define png:color-type=6 "$PUB/icon-512.png"
# maskable: full bleed, motif inside the 80%-diameter safe circle
place_motif "$WORK/motif.png" 512 0.62 "$BG" "$PUB/icon-maskable-512.png"
# iOS applies its own squircle and dislikes transparency, so ship it opaque
place_motif "$WORK/motif.png" 180 0.72 "$BG" "$PUB/apple-touch-icon.png"
magick "$WORK/flat.png" -resize 64x64 -depth 8 -define png:color-type=6 "$PUB/favicon-64.png"
magick "$WORK/flat.png" -resize 32x32 -depth 8 -define png:color-type=6 "$PUB/favicon-32.png"

# --- shrink -----------------------------------------------------------------
# The artwork is amber-on-near-black, so a 255-colour palette is visually
# lossless (RMSE ~0.4%) and cuts the 512px icons from ~210 KB to ~17 KB. That
# matters: the PWA precaches its icons on install.
echo "==> Optimising"
optimise() {
  for f in "$@"; do
    [ -f "$f" ] || continue
    magick "$f" -strip -colors 255 -define png:compression-level=9 "$f"
  done
}
optimise "$RES"/mipmap-*/*.png "$RES"/drawable*/splash.png \
  "$PUB/icon-192.png" "$PUB/icon-512.png" "$PUB/icon-maskable-512.png" \
  "$PUB/apple-touch-icon.png" "$PUB/favicon-64.png" "$PUB/favicon-32.png"

# --- preview sheet ----------------------------------------------------------
if [ "${1:-}" = "--preview" ]; then
  echo "==> Preview sheet"
  bash "$ROOT/scripts/gen-icon-preview.sh"
fi

echo "Done."
