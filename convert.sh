#!/bin/sh
# Usage: ./convert.sh video.webm  ->  video-ig.mp4 (H.264 + AAC, steady 30 fps)
# Picks 1080x1080, 1920x1080 or 1080x1920 from the video's shape.
[ -f "$1" ] || { echo "usage: $0 <video file>"; exit 1; }
out="${1%.*}-ig.mp4"
dims=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "$1")
w=${dims%,*}; h=${dims#*,}
ratio=$((w * 100 / h))
if [ "$ratio" -gt 130 ]; then size=1920:1080
elif [ "$ratio" -lt 75 ]; then size=1080:1920
else size=1080:1080; fi
ffmpeg -y -i "$1" -vf "fps=30,scale=$size:force_original_aspect_ratio=decrease:flags=lanczos,pad=$size:(ow-iw)/2:(oh-ih)/2" \
  -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 256k -ar 44100 -movflags +faststart "$out"
echo "saved: $out ($size)"
