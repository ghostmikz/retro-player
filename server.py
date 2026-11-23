#!/usr/bin/env python3
"""Local server for Retro Player: serves the page and builds the final video.

The browser uploads the screen recording and the original song. The recording's
own audio is only used to find where the clip sits in the song; the final video
gets the original song audio (cut, faded, AAC 320k) so it never has live-capture
glitches.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np

ROOT = Path(__file__).resolve().parent
OUT_DIR = Path.home() / "Videos" / "retro-player"
WORK = Path(tempfile.mkdtemp(prefix="retro-player-"))
SR = 8000
JOBS = {}


def decode_mono(path, start=None, dur=None):
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None:
        cmd += ["-ss", f"{max(0.0, start):.3f}"]
    cmd += ["-i", str(path)]
    if dur is not None:
        cmd += ["-t", f"{dur:.3f}"]
    cmd += ["-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def find_lead(video, song, start, skip=0.0):
    """(lead, gain_db): seconds into the recording where the song is at `start`,
    and how much quieter/louder the player was than the file."""
    rec = decode_mono(video)
    loud = np.flatnonzero(np.abs(rec) > 0.01)
    if not len(loud):
        return None
    t0 = loud[0] / SR + 0.3 + skip
    win = rec[int(t0 * SR): int((t0 + 6) * SR)]
    search_from = max(0.0, start - 4)
    ref = decode_mono(song, search_from, 16)
    if len(win) < SR or len(ref) < len(win):
        return None
    n = len(ref) + len(win)
    c = np.fft.irfft(np.fft.rfft(ref, n) * np.conj(np.fft.rfft(win, n)), n)[: len(ref) - len(win) + 1]
    k = int(np.argmax(c))
    seg = ref[k:k + len(win)]
    score = float(np.dot(seg, win) / (np.linalg.norm(seg) * np.linalg.norm(win) + 1e-9))
    if score < 0.5:
        return None
    p = search_from + k / SR
    gain = 20 * np.log10((np.sqrt(np.mean(win ** 2)) + 1e-9) / (np.sqrt(np.mean(seg ** 2)) + 1e-9))
    return t0 - (p - start), float(gain)


def song_peak(song):
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(song), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.search(r"Peak:\s+(-?[\d.]+) dBFS", r.stderr[r.stderr.rfind("Summary:"):])
    return float(m.group(1)) if m else 0.0


def loudness_gain(song, target=-14.0):
    """dB to add so the song plays at YouTube-like loudness without clipping."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(song), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True)
    txt = r.stderr[r.stderr.rfind("Summary:"):]
    mi = re.search(r"I:\s+(-?[\d.]+) LUFS", txt)
    mp = re.search(r"Peak:\s+(-?[\d.]+) dBFS", txt)
    if not mi:
        return 0.0
    gain = target - float(mi.group(1))
    if mp:
        gain = min(gain, -1.0 - float(mp.group(1)))
    return min(0.0, gain)


def video_size(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    w, h = (int(v) for v in out.split(",")[:2])
    r = w / h
    return "1920:1080" if r > 1.3 else "1080:1920" if r < 0.75 else "1080:1080"


def build(job_id, p):
    job = JOBS[job_id]
    try:
        video, song = job["video"], job["song"]
        start, end = float(p["start"]), float(p["end"])
        fi, fo = max(0.0, float(p.get("fi", 0))), max(0.0, float(p.get("fo", 0)))
        length = end - start
        job["status"] = "Lining up the original audio..."
        found = find_lead(video, song, start, skip=fi)
        if found is None:
            raise RuntimeError("could not find the song in the recording")
        lead, player_gain = found
        lead = max(0.0, lead)
        name = re.sub(r'[\\/:*?"<>|]+', "_", p.get("name", "song")).strip() or "song"
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        out = OUT_DIR / f"{name}.mp4"
        i = 2
        while out.exists():
            out = OUT_DIR / f"{name} ({i}).mp4"
            i += 1
        size = video_size(video)
        vw, vh = (int(v) for v in subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video)],
            capture_output=True, text=True).stdout.strip().split(",")[:2])
        exact = f"{vw}:{vh}" == size
        job["size"] = f"{vw}x{vh} captured" + ("" if exact else f", scaled to {size.replace(':', 'x')}")
        job["status"] = "Matching sound level..."
        level = p.get("level", "player")
        if level == "player":
            gain = min(player_gain, -1.0 - song_peak(song))
        elif level == "youtube":
            gain = loudness_gain(song)
        else:
            gain = 0.0
        af = [f"volume={gain:.2f}dB"] if abs(gain) > 0.05 else []
        if fi > 0:
            af.append(f"afade=t=in:st=0:d={fi:.2f}")
        if fo > 0:
            af.append(f"afade=t=out:st={max(0.0, length - fo):.2f}:d={fo:.2f}")
        job["status"] = "Encoding the final video..."
        cmd = ["ffmpeg", "-v", "error", "-y",
               "-ss", f"{lead:.3f}", "-i", str(video),
               "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", str(song),
               "-map", "0:v:0", "-map", "1:a:0", "-t", f"{length:.3f}",
               "-vf", "fps=30" if exact else f"fps=30,scale={size}:force_original_aspect_ratio=decrease:flags=lanczos,pad={size}:(ow-iw)/2:(oh-ih)/2",
               "-c:v", "libx264", "-preset", "slow", "-crf", "12", "-tune", "animation", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "320k", "-ar", "48000"]
        if af:
            cmd += ["-af", ",".join(af)]
        cmd += ["-movflags", "+faststart", str(out)]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip()[-400:])
        job.update(status="done", path=str(out), lead=round(lead, 3), gain=round(gain, 1))
    except Exception as e:
        job.update(status="error", error=str(e))
    finally:
        for k in ("video", "song"):
            try:
                os.remove(job[k])
            except OSError:
                pass


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, *a):
        pass

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/ping":
            return self.send_json({"ok": True, "out": str(OUT_DIR)})
        if u.path == "/api/status":
            job = JOBS.get(parse_qs(u.query).get("id", [""])[0])
            return self.send_json({k: v for k, v in (job or {"status": "unknown"}).items() if k not in ("video", "song")})
        return super().do_GET()

    def do_POST(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        job_id = re.sub(r"[^a-z0-9]", "", q.get("id", ""))
        if not job_id:
            return self.send_json({"error": "missing id"}, 400)
        job = JOBS.setdefault(job_id, {"status": "uploading"})
        if u.path == "/api/upload":
            part = q.get("part")
            if part not in ("video", "song"):
                return self.send_json({"error": "bad part"}, 400)
            dest = WORK / f"{job_id}-{part}"
            remaining = int(self.headers.get("Content-Length", 0))
            with open(dest, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
            job[part] = dest
            return self.send_json({"ok": True})
        if u.path == "/api/finish":
            if "video" not in job or "song" not in job:
                return self.send_json({"error": "upload missing"}, 400)
            job["status"] = "starting"
            threading.Thread(target=build, args=(job_id, q), daemon=True).start()
            return self.send_json({"ok": True})
        return self.send_json({"error": "not found"}, 404)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        srv.serve_forever()
    finally:
        shutil.rmtree(WORK, ignore_errors=True)


if __name__ == "__main__":
    main()
