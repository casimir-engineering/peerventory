#!/usr/bin/env bash
#
# Build design/icon-preview.png: a contact sheet for eyeballing the generated
# icons. Row 1 is the legacy launcher PNGs at their real pixel sizes on a light
# background (checks that the rounded silhouette, not a black square, survives).
# Row 2 masks the real adaptive layers the way launchers do. Row 3 is the web
# set, including the maskable icon with its 80% safe circle drawn on top.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES="$ROOT/app/android/app/src/main/res"
PUB="$ROOT/app/public"
OUT="$ROOT/design/icon-preview.png"
BG="#0d0e12"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CELL=224
LABEL_H=34
SHEET_BG='#20242c'
PANEL='#c9cdd6'
FONT="${PV_PREVIEW_FONT:-/System/Library/Fonts/Supplemental/Arial.ttf}"
[ -f "$FONT" ] || FONT="$(magick -list font | sed -n 's/^ *glyphs: //p' | head -1)"

# tile <image> <panel-bg> <label> <out>
tile() {
  magick -size "${CELL}x${CELL}" "xc:$2" "$1" -gravity center -composite \
    -background "$SHEET_BG" -fill '#dfe3ea' -font "$FONT" -pointsize 15 \
    -size "${CELL}x${LABEL_H}" -gravity center label:"$3" \
    -append +size "$4"
}

# --- row 1: legacy launcher PNGs at native size, on light and on dark --------
i=0
for spec in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  d="${spec%%:*}"; s="${spec##*:}"
  tile "$RES/mipmap-$d/ic_launcher.png" "$PANEL" "$d  ${s}px" "$WORK/r1-$i.png"
  i=$((i + 1))
done
magick "$WORK"/r1-*.png +append -background "$SHEET_BG" "$WORK/row1.png"

# --- row 2: adaptive layers under the masks launchers apply ------------------
# Compose the real 432px layers exactly as Android does, then crop to the 72dp
# viewport (the middle 66.7%) before masking.
magick -size 432x432 "xc:$BG" "$RES/mipmap-xxxhdpi/ic_launcher_foreground.png" \
  -composite -gravity center -crop 288x288+0+0 +repage -resize 192x192 \
  "$WORK/adaptive.png"

magick -size 192x192 xc:none -fill white -draw 'circle 96,96 96,0' "$WORK/m-circle.png"
magick -size 192x192 xc:none -fill white \
  -draw 'roundrectangle 0,0 191,191 42,42' "$WORK/m-squircle.png"

j=0
for m in circle squircle; do
  magick "$WORK/adaptive.png" "$WORK/m-$m.png" \
    -alpha off -compose CopyOpacity -composite "$WORK/adaptive-$m.png"
  tile "$WORK/adaptive-$m.png" "$PANEL" "adaptive: $m mask" "$WORK/r2-$j.png"
  j=$((j + 1))
done

# Android 13 themed icon: the launcher tints the monochrome layer's alpha with
# wallpaper colours, so simulate that rather than showing the white silhouette.
magick "$RES/mipmap-xxxhdpi/ic_launcher_monochrome.png" -alpha extract \
  -alpha shape -fill '#f5c76a' -colorize 100 "$WORK/mono-shape.png"
magick -size 432x432 "xc:#4a3b1f" "$WORK/mono-shape.png" -composite \
  -gravity center -crop 288x288+0+0 +repage -resize 192x192 \
  "$WORK/m-circle.png" -alpha off -compose CopyOpacity -composite \
  "$WORK/themed.png"
tile "$WORK/themed.png" "$PANEL" "themed (monochrome layer)" "$WORK/r2-2.png"
# unmasked full canvas, so the safe-zone margin is visible
magick -size 432x432 "xc:$BG" "$RES/mipmap-xxxhdpi/ic_launcher_foreground.png" \
  -composite -resize 192x192 -stroke '#f5a52488' -strokewidth 2 -fill none \
  -draw 'rectangle 32,32 159,159' "$WORK/adaptive-full.png"
tile "$WORK/adaptive-full.png" "$PANEL" "108dp canvas + 72dp box" "$WORK/r2-3.png"
magick "$RES/mipmap-xxxhdpi/ic_launcher_round.png" -resize 192x192 "$WORK/round.png"
tile "$WORK/round.png" "$PANEL" "ic_launcher_round" "$WORK/r2-4.png"
magick "$WORK"/r2-*.png +append -background "$SHEET_BG" "$WORK/row2.png"

# --- row 3: web set ----------------------------------------------------------
magick "$PUB/icon-192.png" -resize 192x192 "$WORK/w0.png"
tile "$WORK/w0.png" "$PANEL" "PWA icon-192 (any)" "$WORK/r3-0.png"
magick "$PUB/icon-512.png" -resize 192x192 "$WORK/w1.png"
tile "$WORK/w1.png" "$PANEL" "PWA icon-512 (any)" "$WORK/r3-1.png"
magick "$PUB/icon-maskable-512.png" -resize 192x192 \
  -stroke '#f5a52488' -strokewidth 2 -fill none -draw 'circle 96,96 96,19' \
  "$WORK/w2.png"
tile "$WORK/w2.png" "$PANEL" "maskable + 80% safe circle" "$WORK/r3-2.png"
magick "$PUB/icon-maskable-512.png" -resize 192x192 "$WORK/m-circle.png" \
  -alpha off -compose CopyOpacity -composite "$WORK/w3.png"
tile "$WORK/w3.png" "$PANEL" "maskable, circle-masked" "$WORK/r3-3.png"
magick "$PUB/favicon-32.png" -filter point -resize 192x192 "$WORK/w4.png"
tile "$WORK/w4.png" "$PANEL" "favicon-32 (8x nearest)" "$WORK/r3-4.png"
magick "$WORK"/r3-*.png +append -background "$SHEET_BG" "$WORK/row3.png"

magick "$WORK/row1.png" "$WORK/row2.png" "$WORK/row3.png" \
  -background "$SHEET_BG" -append \
  -bordercolor "$SHEET_BG" -border 20 -depth 8 "$OUT"

magick identify "$OUT"
