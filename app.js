"use strict";

let SW = 1080, SH = 1080;
const ZOOM = 2;
const ASPECTS = { "1:1": [1080, 1080], "16:9": [1920, 1080], "9:16": [1080, 1920] };
const WA_SIZE = { main: { w: 275, h: 116 }, full: { w: 275, h: 464 }, tallpl: { w: 275, h: 464 } };
const LAYOUTS = {
  "1:1": {
    art: { label: "Player + big album art + lyrics", wa: { x: 0, y: 0, kind: "main" }, art: { x: 0, y: 116, w: 275, h: 348 }, lyr: { x: 275, y: 0, w: 225, h: 464 } },
    classic: { label: "Player + equalizer + playlist + lyrics", wa: { x: 0, y: 0, kind: "full" }, lyr: { x: 275, y: 0, w: 225, h: 464 } },
  },
  "16:9": {
    art: { label: "Huge album art + player + lyrics", art: { x: 0, y: 0, w: 440, h: 464 }, wa: { x: 440, y: 0, kind: "main" }, lyr: { x: 440, y: 116, w: 275, h: 348 } },
    wide: { label: "Player + album art + wide lyrics", wa: { x: 0, y: 0, kind: "main" }, art: { x: 0, y: 116, w: 275, h: 348 }, lyr: { x: 275, y: 0, w: 500, h: 464 } },
    classic: { label: "Player + equalizer + playlist + lyrics", wa: { x: 0, y: 0, kind: "full" }, lyr: { x: 275, y: 0, w: 450, h: 464 } },
    compact: { label: "Player + tall playlist + lyrics", wa: { x: 0, y: 0, kind: "tallpl" }, lyr: { x: 275, y: 0, w: 450, h: 464 } },
  },
  "9:16": {
    art: { label: "Huge album art + player + lyrics", art: { x: 0, y: 0, w: 510, h: 560 }, wa: { x: 0, y: 560, kind: "main" }, lyr: { x: 0, y: 676, w: 510, h: 260 } },
  },
};
let L = LAYOUTS["1:1"].art, LWIN = L.lyr, waKind = null;

const $ = (id) => document.getElementById(id);
const stage = $("stage"), wallCv = $("wall"), lyrCv = $("lyr");
const wall = wallCv.getContext("2d"), lg = lyrCv.getContext("2d");

const state = {
  title: "", artist: "", lyrics: "", offset: 0, sweep: true,
  skin: "skins/classic.wsz", layout: "art", aspect: "1:1", bgMode: "color", bgColor: "#3a6ea5",
  clipStart: "", clipEnd: "", helper: "", fadeIn: 1, fadeOut: 2, level: "player",
};
let webamp = null;
let skinParts = null, fallbackParts = null;
let cover = null, wallImg = null;
let timed = [];
let scroll = 0;
let duration = 0;
let clock = { elapsed: 0, at: 0, playing: false };
let sync = null, recording = null;
let audioUrl = null, songFile = null;

// ---------- helpers ----------
const fmt = (s) => {
  s = Math.max(0, s || 0);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(Math.floor(s % 60)).padStart(2, "0");
};
const lrcTime = (s) => {
  const m = Math.floor(s / 60), r = s - m * 60;
  return "[" + String(m).padStart(2, "0") + ":" + r.toFixed(2).padStart(5, "0") + "]";
};
const parseClock = (v) => {
  v = (v || "").trim();
  if (!v) return null;
  const p = v.split(":").map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 1 ? p[0] : p[0] * 60 + p[1];
};
const META = /^\[(ti|ar|al|by|offset|length):/i;
const stripTimes = (l) => l.replace(/\[[^\]]*\]/g, "").trim();
function parseLyrics(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const body = stripTimes(raw);
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text: body });
  }
  out.sort((a, b) => a.t - b.t);
  const lines = [];
  out.forEach((e, i) => {
    if (!e.text) return;
    const nx = out[i + 1];
    lines.push({ t: e.t, text: e.text, end: nx ? nx.t : e.t + 6, hasEnd: !!(nx && !nx.text) });
  });
  return lines;
}
function save() { try { localStorage.setItem("retro-player-webamp", JSON.stringify(state)); } catch (e) {} }
function load() { try { Object.assign(state, JSON.parse(localStorage.getItem("retro-player-webamp") || "{}")); } catch (e) {} }
function loadImage(src) {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = typeof src === "string" ? src : URL.createObjectURL(src);
  });
}

// ---------- time ----------
function now() {
  if (!clock.playing) return clock.elapsed;
  return Math.min(duration || Infinity, clock.elapsed + (performance.now() - clock.at) / 1000);
}
function syncClock() {
  if (!webamp) return;
  const s = webamp.store.getState();
  const el = s.media.timeElapsed || 0;
  const playing = webamp.getMediaStatus() === "PLAYING";
  if (el !== clock.lastRaw || playing !== clock.playing) {
    clock.lastRaw = el;
    const predicted = now();
    if (!playing || Math.abs(predicted - el) > 0.35 || el > predicted) clock.elapsed = el;
    else clock.elapsed = predicted;
    clock.at = performance.now();
    clock.playing = playing;
  }
  const tr = webamp.getPlaylistTracks()[0];
  if (tr && tr.duration) duration = tr.duration;
}

// ---------- skin parsing ----------
async function parseSkin(blob) {
  const zip = await JSZip.loadAsync(blob);
  const find = (name) => {
    let hit = null;
    zip.forEach((path, f) => {
      if (!f.dir && path.split("/").pop().toLowerCase() === name) hit = hit || f;
    });
    return hit;
  };
  const img = async (name) => {
    const f = find(name);
    if (!f) return null;
    try { return await loadImage(new Blob([await f.async("uint8array")], { type: "image/bmp" })); } catch (e) { return null; }
  };
  const parts = { pledit: await img("pledit.bmp"), gen: await img("gen.bmp"), colors: {} };
  const txt = find("pledit.txt");
  if (txt) {
    const s = await txt.async("string");
    for (const line of s.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.+?)\s*$/);
      if (m) parts.colors[m[1].toLowerCase()] = m[2];
    }
  }
  if (parts.gen) parts.genLetters = genLetters(parts.gen);
  return parts;
}
function genLetters(img) {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const px = (xx, yy) => x.getImageData(xx, yy, 1, 1).data.join(",");
  const letters = {};
  for (const [row, key] of [[88, "sel"], [96, "norm"]]) {
    if (img.height <= row) continue;
    const bg = px(0, row);
    let i = 1;
    letters[key] = {};
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      let s = i;
      while (s < img.width && px(s, row) !== bg) s++;
      letters[key][ch] = { x: i, y: row, w: s - i, h: 7 };
      i = s + 1;
    }
  }
  return letters;
}
function color(name, fallback) {
  const v = (skinParts && skinParts.colors[name]) || (fallbackParts && fallbackParts.colors[name]) || fallback;
  return v.startsWith("#") ? v : "#" + v;
}
function skinFont() {
  const f = ((skinParts && skinParts.colors.font) || "Arial").toLowerCase();
  if (f.includes("tahoma") || f.includes("verdana")) return '"DejaVu Sans", "Liberation Sans", "DotGothic16", sans-serif';
  if (f.includes("courier") || f.includes("lucida console") || f.includes("mono")) return '"Liberation Mono", "DejaVu Sans Mono", "DotGothic16", monospace';
  if (f.includes("times") || f.includes("georgia")) return '"Liberation Serif", "DejaVu Serif", "DotGothic16", serif';
  return '"Liberation Sans", Arial, "DotGothic16", "DejaVu Sans", sans-serif';
}

// ---------- lyrics window ----------
let dc = null;
function sprite(img, sx, sy, sw, sh, dx, dy, dw = sw, dh = sh) {
  if (!img || sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  dc.drawImage(img, sx, sy, sw, sh, dx * ZOOM, dy * ZOOM, dw * ZOOM, dh * ZOOM);
}
function tileX(img, s, x0, x1, y) {
  for (let x = x0; x < x1; x += s.w) sprite(img, s.x, s.y, Math.min(s.w, x1 - x), s.h, x, y);
}
function tileY(img, s, x, y0, y1) {
  for (let y = y0; y < y1; y += s.h) sprite(img, s.x, s.y, s.w, Math.min(s.h, y1 - y), x, y);
}
function drawFrame(ctx, W, H, word) {
  dc = ctx;
  ctx.imageSmoothingEnabled = false;
  const gen = skinParts && skinParts.gen && skinParts.genLetters ? skinParts.gen : null;
  if (gen) {
    const Lt = skinParts.genLetters.norm;
    const cw = (ch) => (Lt[ch] ? Lt[ch].w : 4);
    const tw = [...word].reduce((a, ch) => a + cw(ch) + 1, 0) - 1;
    const block = 25 + tw + 4 + 25;
    const bx = Math.round((W - block) / 2);
    sprite(gen, 0, 21, 25, 20, 0, 0);
    tileX(gen, { x: 104, y: 21, w: 25, h: 20 }, 25, bx, 0);
    sprite(gen, 26, 21, 25, 20, bx, 0);
    tileX(gen, { x: 52, y: 21, w: 25, h: 20 }, bx + 25, bx + 25 + tw + 4, 0);
    sprite(gen, 78, 21, 25, 20, bx + 25 + tw + 4, 0);
    tileX(gen, { x: 104, y: 21, w: 25, h: 20 }, bx + block, W - 25, 0);
    sprite(gen, 130, 21, 25, 20, W - 25, 0);
    let lx = bx + 27;
    for (const ch of word) { const s = Lt[ch]; if (s) sprite(gen, s.x, s.y, s.w, s.h, lx, 4); lx += cw(ch) + 1; }
    tileY(gen, { x: 127, y: 42, w: 11, h: 29 }, 0, 20, H - 14);
    tileY(gen, { x: 139, y: 42, w: 8, h: 29 }, W - 8, 20, H - 14);
    sprite(gen, 0, 42, 125, 14, 0, H - 14);
    tileX(gen, { x: 127, y: 72, w: 25, h: 14 }, 125, W - 125, H - 14);
    sprite(gen, 0, 57, 125, 14, W - 125, H - 14);
    return { x: 11, y: 20, w: W - 19, h: H - 34, scroll: null };
  }
  const pl = (skinParts && skinParts.pledit) || (fallbackParts && fallbackParts.pledit);
  sprite(pl, 0, 21, 25, 20, 0, 0);
  tileX(pl, { x: 127, y: 21, w: 25, h: 20 }, 25, W - 25, 0);
  sprite(pl, 26, 21, 100, 20, Math.round((W - 100) / 2), 0);
  sprite(pl, 153, 21, 25, 20, W - 25, 0);
  tileY(pl, { x: 0, y: 42, w: 12, h: 29 }, 0, 20, H - 38);
  tileY(pl, { x: 31, y: 42, w: 20, h: 29 }, W - 20, 20, H - 38);
  sprite(pl, 0, 72, 125, 38, 0, H - 38);
  tileX(pl, { x: 179, y: 0, w: 25, h: 38 }, 125, W - 150, H - 38);
  sprite(pl, 126, 72, 150, 38, W - 150, H - 38);
  return { x: 12, y: 20, w: W - 32, h: H - 58, scroll: { img: pl, x: W - 15, y0: 20, y1: H - 38 } };
}
function layer() {
  const c = document.createElement("canvas");
  return { c, x: c.getContext("2d", { willReadFrequently: true }) };
}
function sizeLayer(l, w, h) {
  if (l.c.width !== w || l.c.height !== h) { l.c.width = w; l.c.height = h; }
  l.x.clearRect(0, 0, w, h);
}
function harden(l) {
  const d = l.x.getImageData(0, 0, l.c.width, l.c.height), a = d.data;
  for (let i = 3; i < a.length; i += 4) a[i] = a[i] >= 110 ? 255 : 0;
  l.x.putImageData(d, 0, 0);
}
function blit(ctx, l, x, y) {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(l.c, x * ZOOM, y * ZOOM, l.c.width * ZOOM, l.c.height * ZOOM);
}
function wrapText(ctx, str, font, maxW) {
  ctx.font = font;
  const words = str.split(/\s+/).filter(Boolean);
  const rows = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width <= maxW) { cur = t; continue; }
    if (cur && ctx.measureText(w).width <= maxW) { rows.push(cur); cur = w; continue; }
    let piece = cur ? cur + " " : "";
    for (const ch of w) {
      if (piece && ctx.measureText(piece + ch).width > maxW) { rows.push(piece.trimEnd()); piece = ""; }
      piece += ch;
    }
    cur = piece;
  }
  if (cur) rows.push(cur);
  return rows.length ? rows : ["..."];
}
function fitText(ctx, str, font, maxW) {
  ctx.font = font;
  if (ctx.measureText(str).width <= maxW) return str;
  while (str.length > 1 && ctx.measureText(str + "...").width > maxW) str = str.slice(0, -1);
  return str + "...";
}

const LB = layer(), LT = layer();
function drawLyrics() {
  lg.clearRect(0, 0, lyrCv.width, lyrCv.height);
  const area = drawFrame(lg, LWIN.w, LWIN.h, "LYRICS");
  const W = area.w, H = area.h;
  sizeLayer(LB, W, H); sizeLayer(LT, W, H);
  const bx = LB.x, tx = LT.x;
  const bg = color("normalbg", "#000000"), fg = color("normal", "#00ff00");
  const curC = color("current", "#ffffff"), selBg = color("selectedbg", "#0000c6");
  bx.fillStyle = bg; bx.fillRect(0, 0, W, H);

  const fam = skinFont();
  const fN = `14px ${fam}`, fC = `bold 14px ${fam}`;
  const rowH = 17, padL = 4;
  const textW = W - padL * 2;
  const t = now(), lt = t - state.offset / 1000;
  let idx = -1;
  for (let k = 0; k < timed.length; k++) { if (timed[k].t <= lt) idx = k; else break; }
  const active = idx >= 0 && (!timed[idx].hasEnd || lt < timed[idx].end);

  const blocks = [];
  let acc = 0;
  for (let k = 0; k < timed.length; k++) {
    const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(timed[k].text);
    const rows = wrapText(tx, timed[k].text || "...", k === idx && active && !cjk ? fC : fN, textW);
    blocks.push({ rows, top: acc, h: rows.length * rowH, cjk });
    acc += rows.length * rowH + 2;
  }
  let target = idx >= 0 ? blocks[idx].top + blocks[idx].h / 2 - H * 0.4 : 0;
  target = Math.max(0, target);
  scroll += (target - scroll) * 0.15;
  if (Math.abs(target - scroll) < 0.5) scroll = target;
  const off = Math.round(scroll);

  tx.textBaseline = "alphabetic";
  if (!timed.length) {
    tx.font = fN; tx.fillStyle = fg;
    tx.fillText(state.lyrics.trim() ? "Press Sync to time the lyrics" : "No lyrics loaded", padL, 14);
  }
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    const by = 2 + b.top - off;
    if (by > H || by + b.h < 0) continue;
    const cur = k === idx && active;
    if (cur) { bx.fillStyle = selBg; bx.fillRect(0, by, W, b.h + 1); }
    const font = cur && !b.cjk ? fC : fN;
    tx.font = font;
    let prog = 1;
    if (cur && state.sweep) {
      const ln = timed[k];
      const span = Math.max(0.3, ln.hasEnd ? ln.end - ln.t : Math.min(ln.end - ln.t, 8) * 0.95);
      prog = Math.min(1, Math.max(0, (lt - ln.t) / span));
    }
    const widths = b.rows.map((r) => tx.measureText(r).width);
    let fill = widths.reduce((a2, c) => a2 + c, 0) * prog;
    b.rows.forEach((row, r) => {
      const base = by + r * rowH + 13;
      tx.fillStyle = cur ? fg : fg;
      tx.globalAlpha = 1;
      tx.fillText(row, padL, base);
      if (cur) {
        const fw = Math.min(widths[r], fill); fill -= fw;
        if (fw > 0) {
          tx.save(); tx.beginPath(); tx.rect(padL - 1, by + r * rowH, Math.ceil(fw) + 1, rowH); tx.clip();
          tx.clearRect(padL - 1, by + r * rowH, Math.ceil(fw) + 1, rowH);
          tx.fillStyle = curC; tx.fillText(row, padL, base);
          tx.restore();
        }
      }
    });
  }
  harden(LT);
  if (idx > 0) {
    const pastEnd = Math.max(0, Math.min(H, 2 + blocks[idx].top - off));
    if (pastEnd > 0) {
      LT.x.globalCompositeOperation = "source-atop";
      LT.x.globalAlpha = 0.45; LT.x.fillStyle = bg; LT.x.fillRect(0, 0, W, pastEnd);
      LT.x.globalAlpha = 1; LT.x.globalCompositeOperation = "source-over";
    }
  }
  blit(lg, LB, area.x, area.y);
  blit(lg, LT, area.x, area.y);

  if (area.scroll && area.scroll.img) {
    dc = lg;
    const s = area.scroll, p = duration ? Math.min(1, t / duration) : 0;
    const y = s.y0 + Math.round((s.y1 - s.y0 - 18) * p);
    sprite(s.img, 52, 53, 8, 18, s.x, y);
  }
}

// ---------- desktop ----------
function drawWall() {
  wall.filter = "none";
  wall.fillStyle = state.bgColor; wall.fillRect(0, 0, SW, SH);
  const src = state.bgMode === "image" ? wallImg : state.bgMode === "cover" ? cover : null;
  if (!src) return;
  const s = Math.max(SW / src.width, SH / src.height), sw = SW / s, sh = SH / s;
  if (state.bgMode === "cover") {
    wall.filter = "blur(50px) saturate(1.2)";
    wall.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, -100, -100, SW + 200, SH + 200);
    wall.filter = "none";
    wall.fillStyle = "rgba(0,0,0,0.25)"; wall.fillRect(0, 0, SW, SH);
  } else {
    wall.drawImage(src, (src.width - sw) / 2, (src.height - sh) / 2, sw, sh, 0, 0, SW, SH);
  }
}

// ---------- layout ----------
let capK = 0;
function placeStage() {
  const wrap = $("stageWrap");
  const rec = document.body.classList.contains("recording");
  const pad = rec ? 0 : 16;
  const aw = wrap.clientWidth - pad * 2, ah = wrap.clientHeight - pad * 2;
  const dpr = window.devicePixelRatio || 1;
  let s = Math.min(aw / SW, ah / SH);
  const exact = 1 / (capK || dpr);
  if (rec && SW * exact <= aw + 0.5 && SH * exact <= ah + 0.5) s = exact;
  const snap = (v) => Math.round(v * dpr) / dpr;
  stage.style.transform = `scale(${s})`;
  stage.style.left = snap(pad + (aw - SW * s) / 2) + "px";
  stage.style.top = snap(pad + (ah - SH * s) / 2) + "px";
}
function layoutWindows() {
  [SW, SH] = ASPECTS[state.aspect] || ASPECTS["1:1"];
  const set = LAYOUTS[state.aspect] || LAYOUTS["1:1"];
  L = set[state.layout] || set.art;
  LWIN = L.lyr;
  stage.style.width = SW + "px"; stage.style.height = SH + "px";
  wallCv.width = SW; wallCv.height = SH;
  wallCv.style.width = SW + "px"; wallCv.style.height = SH + "px";
  const ws = WA_SIZE[L.wa.kind];
  const boxes = [{ x: L.wa.x, y: L.wa.y, w: ws.w, h: ws.h }, L.lyr];
  if (L.art) boxes.push(L.art);
  const bw = Math.max(...boxes.map((b) => b.x + b.w)), bh = Math.max(...boxes.map((b) => b.y + b.h));
  const ox = Math.round((SW / ZOOM - bw) / 2), oy = Math.round((SH / ZOOM - bh) / 2);
  const px = (v) => v * ZOOM + "px";
  const wa = $("wa");
  wa.style.left = px(ox + L.wa.x); wa.style.top = px(oy + L.wa.y);
  wa.style.width = ws.w + "px"; wa.style.height = ws.h + "px";
  wa.style.transform = `scale(${ZOOM})`;
  lyrCv.width = LWIN.w * ZOOM; lyrCv.height = LWIN.h * ZOOM;
  lyrCv.style.left = px(ox + LWIN.x); lyrCv.style.top = px(oy + LWIN.y);
  const art = $("art");
  art.hidden = !L.art;
  if (L.art) {
    art.width = L.art.w * ZOOM; art.height = L.art.h * ZOOM;
    art.style.left = px(ox + L.art.x); art.style.top = px(oy + L.art.y);
  }
  artKey = "";
  scroll = 0;
}
function fillLayoutSel() {
  const set = LAYOUTS[state.aspect] || LAYOUTS["1:1"];
  if (!set[state.layout]) state.layout = "art";
  $("layoutSel").innerHTML = Object.entries(set).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("layoutSel").value = state.layout;
}
async function applyLayout() {
  fillLayoutSel();
  layoutWindows();
  placeStage();
  drawWall();
  if (webamp && waKind !== L.wa.kind) await rebuildWebamp();
}

var artKey = "", skinVer = 0;
function drawArt() {
  if (!L.art) return;
  const key = [state.skin, state.title, state.artist, cover ? cover.src : "", skinVer].join("|");
  if (key === artKey) return;
  artKey = key;
  const cv = $("art"), ac = cv.getContext("2d");
  ac.clearRect(0, 0, cv.width, cv.height);
  const a = drawFrame(ac, L.art.w, L.art.h, "ALBUM ART");
  const x = a.x * ZOOM, y = a.y * ZOOM, w = a.w * ZOOM, h = a.h * ZOOM;
  ac.fillStyle = color("normalbg", "#000000"); ac.fillRect(x, y, w, h);
  const size = Math.min(w - 16, h - 96) & ~1;
  const cx = x + Math.round((w - size) / 2), cy = y + 8;
  ac.imageSmoothingEnabled = true; ac.imageSmoothingQuality = "high";
  if (cover) {
    const s = Math.max(size / cover.width, size / cover.height);
    const sw = size / s, sh = size / s;
    ac.drawImage(cover, (cover.width - sw) / 2, (cover.height - sh) / 2, sw, sh, cx, cy, size, size);
  } else {
    ac.fillStyle = color("selectedbg", "#0000c6"); ac.fillRect(cx, cy, size, size);
    
  }
  const fam = skinFont();
  const tw = a.w, th = Math.max(1, a.h - Math.round((cy - y + size) / ZOOM));
  const T = layer();
  sizeLayer(T, tw, th);
  T.x.textBaseline = "alphabetic";
  const tf = `bold 15px ${fam}`, af = `13px ${fam}`;
  T.x.font = tf; T.x.fillStyle = color("current", "#ffffff");
  T.x.fillText(fitText(T.x, state.title || "untitled", tf, tw - 10), 5, 18);
  T.x.font = af; T.x.fillStyle = color("normal", "#00ff00");
  T.x.fillText(fitText(T.x, state.artist || "", af, tw - 10), 5, 35);
  harden(T);
  blit(ac, T, a.x, Math.round((cy + size) / ZOOM));
}

// ---------- webamp ----------
async function setSkin(url) {
  try {
    const blob = await (await fetch(url)).blob();
    skinParts = await parseSkin(blob);
  } catch (e) { console.warn("skin parse failed", e); skinParts = null; }
  skinVer++;
  if (webamp) webamp.setSkinFromUrl(url);
}
function eqLayout(kind) {
  const main = { position: { left: 0, top: 0 } };
  if (kind === "main") return { main, equalizer: { position: { left: 0, top: 116 }, closed: true }, playlist: { position: { left: 0, top: 116 }, closed: true } };
  if (kind === "full") return { main, equalizer: { position: { left: 0, top: 116 } }, playlist: { position: { left: 0, top: 232 }, size: { extraWidth: 0, extraHeight: 4 } } };
  return { main, equalizer: { position: { left: 0, top: 116 }, closed: true }, playlist: { position: { left: 0, top: 116 }, size: { extraWidth: 0, extraHeight: 8 } } };
}
async function startWebamp() {
  waKind = L.wa.kind;
  webamp = new Webamp({
    initialSkin: { url: state.skin },
    windowLayout: eqLayout(waKind),
    enableHotkeys: false,
    zIndex: 1,
  });
  await webamp.renderInto($("wa"));
  webamp.setVolume(100);
}
async function rebuildWebamp() {
  const kind = L.wa.kind;
  const wins = webamp.store.getState().windows.genWindows;
  const want = { equalizer: kind === "full", playlist: kind !== "main" };
  for (const id of ["equalizer", "playlist"]) {
    if (wins[id] && wins[id].open !== want[id]) webamp.store.dispatch({ type: "TOGGLE_WINDOW", windowId: id });
  }
  webamp.store.dispatch({ type: "WINDOW_SIZE_CHANGED", windowId: "playlist", size: [0, kind === "full" ? 4 : 8] });
  webamp.store.dispatch({ type: "UPDATE_WINDOW_POSITIONS", positions: { main: { x: 0, y: 0 }, equalizer: { x: 0, y: 116 }, playlist: { x: 0, y: kind === "full" ? 232 : 116 } } });
  waKind = kind;
}

// ---------- panel ----------
function setLyrics(text, fromInput) {
  state.lyrics = text;
  if (!fromInput) $("lyrics").value = text;
  timed = parseLyrics(text);
  save();
}
$("skinSel").addEventListener("change", (e) => { state.skin = e.target.value; setSkin(state.skin); save(); });
$("skinFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const opt = document.createElement("option");
  opt.value = url; opt.textContent = f.name.replace(/\.(wsz|zip)$/i, "") + " (loaded)";
  $("skinSel").appendChild(opt); $("skinSel").value = url;
  setSkin(url);
});
$("layoutSel").addEventListener("change", async (e) => { state.layout = e.target.value; save(); await applyLayout(); });
$("aspectSel").addEventListener("change", async (e) => { state.aspect = e.target.value; state.layout = "art"; save(); await applyLayout(); });
$("audioFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  let tags = {};
  try { tags = readID3(await f.arrayBuffer()); } catch (err) {}
  let title = tags.title, artist = tags.artist;
  const base = f.name.replace(/\.[^.]+$/, "");
  if (!title) {
    const m = base.split(" - ");
    if (m.length >= 2) { artist = artist || m[0].trim(); title = m.slice(1).join(" - ").trim(); } else title = base;
  }
  state.title = title; state.artist = artist || "";
  $("title").value = state.title; $("artist").value = state.artist;
  if (tags.picture) { try { cover = await loadImage(tags.picture); drawWall(); } catch (err) {} }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = URL.createObjectURL(f);
  songFile = f;
  loadTrack();
  ["playBtn", "seek", "syncBtn", "recBtn"].forEach((id) => ($(id).disabled = false));
  save();
});
function loadTrack() {
  if (!audioUrl) return;
  webamp.store.dispatch({ type: "REMOVE_ALL_TRACKS" });
  webamp.appendTracks([{ url: audioUrl, metaData: { title: state.title || "untitled", artist: state.artist || "" } }]);
  webamp.setCurrentTrack(0);
}
$("title").addEventListener("change", (e) => { state.title = e.target.value; save(); if (webamp.getMediaStatus() !== "PLAYING") loadTrack(); });
$("artist").addEventListener("change", (e) => { state.artist = e.target.value; save(); if (webamp.getMediaStatus() !== "PLAYING") loadTrack(); });
$("coverFile").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) { cover = await loadImage(f); if (state.bgMode === "color") { state.bgMode = "cover"; $("bgMode").value = "cover"; } drawWall(); save(); } });
$("bgFile").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) { wallImg = await loadImage(f); state.bgMode = "image"; $("bgMode").value = "image"; drawWall(); save(); } });
$("bgMode").addEventListener("change", (e) => { state.bgMode = e.target.value; drawWall(); save(); });
$("bgColor").addEventListener("input", (e) => { state.bgColor = e.target.value; drawWall(); save(); });
$("lyrics").addEventListener("input", (e) => setLyrics(e.target.value, true));
$("helper").addEventListener("input", (e) => { state.helper = e.target.value; save(); });
$("offset").addEventListener("input", (e) => { state.offset = Number(e.target.value) || 0; save(); });
$("sweep").addEventListener("change", (e) => { state.sweep = e.target.checked; save(); });
$("clipStart").addEventListener("input", (e) => { state.clipStart = e.target.value; save(); });
$("level").addEventListener("change", (e) => { state.level = e.target.value; save(); });
$("fadeIn").addEventListener("input", (e) => { state.fadeIn = e.target.value; save(); });
$("fadeOut").addEventListener("input", (e) => { state.fadeOut = e.target.value; save(); });
$("clipEnd").addEventListener("input", (e) => { state.clipEnd = e.target.value; save(); });

async function cueTo(t) {
  const vol = webamp.store.getState().media.volume;
  webamp.setVolume(0);
  if (webamp.getMediaStatus() !== "PLAYING") webamp.play();
  for (let i = 0; i < 60 && webamp.getMediaStatus() !== "PLAYING"; i++) await sleep(50);
  const e0 = webamp.store.getState().media.timeElapsed || 0;
  for (let i = 0; i < 60 && (webamp.store.getState().media.timeElapsed || 0) <= e0; i++) await sleep(50);
  webamp.seekToTime(t);
  for (let i = 0; i < 60 && Math.abs((webamp.store.getState().media.timeElapsed || 0) - t) > 0.4; i++) await sleep(50);
  webamp.pause();
  for (let i = 0; i < 40 && webamp.getMediaStatus() !== "PAUSED"; i++) await sleep(50);
  webamp.setVolume(vol || 100);
  clock.elapsed = webamp.store.getState().media.timeElapsed || t; clock.at = performance.now(); clock.playing = false;
}
function play() { if (webamp.getMediaStatus() !== "PLAYING") webamp.play(); }
function pause() { if (webamp.getMediaStatus() === "PLAYING") webamp.pause(); }
function seekTo(s) { webamp.seekToTime(s); clock.elapsed = s; clock.at = performance.now(); }
$("playBtn").addEventListener("click", () => (webamp.getMediaStatus() === "PLAYING" ? pause() : play()));
let seeking = false;
$("seek").addEventListener("input", (e) => { seeking = true; if (duration) seekTo((e.target.value / 1000) * duration); });
$("seek").addEventListener("change", () => { seeking = false; });

$("lrcFile").addEventListener("change", async (e) => { const f = e.target.files[0]; if (f) setLyrics(await f.text()); e.target.value = ""; });
$("saveLrc").addEventListener("click", () => {
  const head = (state.title ? `[ti:${state.title}]\n` : "") + (state.artist ? `[ar:${state.artist}]\n` : "");
  const body = state.lyrics.split(/\r?\n/).filter((l) => !META.test(l)).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([head + body + "\n"], { type: "text/plain" }));
  a.download = (state.title || "lyrics") + ".lrc";
  a.click();
});
$("clearTimes").addEventListener("click", () => {
  setLyrics(state.lyrics.split(/\r?\n/).filter((l) => !META.test(l)).map(stripTimes).join("\n"));
});

// ---------- sync ----------
function writeSync() {
  const out = [];
  sync.lines.forEach((l, i) => {
    const st = sync.stamps[i];
    out.push((st ? lrcTime(st.s) : "") + l);
    if (st && st.e != null && st.e - st.s >= 0.25) {
      const nx = sync.stamps[i + 1];
      if (!nx || nx.s - st.e >= 0.3) out.push(lrcTime(st.e));
    }
  });
  setLyrics(out.join("\n"));
  const holding = sync.holding;
  const i = holding ? sync.stamps.length - 1 : sync.stamps.length;
  const help = state.helper.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  $("syncLabel").textContent = holding ? "Singing now - let go of Space when this line ends:" : "Next line - press and hold Space when it starts:";
  $("syncNext").textContent = i < sync.lines.length ? sync.lines[i] : "(done - let it play or press Esc)";
  $("syncHelp").textContent = help[i] || "";
  $("syncAfter").textContent = i + 1 < sync.lines.length ? "then: " + (help[i + 1] || sync.lines[i + 1]) : "";
  $("syncBox").classList.toggle("holding", !!holding);
}
function startSync() {
  const lines = state.lyrics.split(/\r?\n/).filter((l) => !META.test(l)).map(stripTimes).filter(Boolean);
  if (!lines.length) { alert("Paste the lyrics first."); return; }
  sync = { lines, stamps: [], holding: false };
  writeSync();
  $("syncBox").hidden = false; $("syncBtn").textContent = "Stop sync"; $("lyrics").readOnly = true;
  document.activeElement.blur();
  seekTo(0); play();
}
function stopSync() {
  if (!sync) return;
  sync = null; pause();
  $("syncBox").hidden = true; $("syncBtn").textContent = "Sync"; $("lyrics").readOnly = false;
}
function lastTime() {
  const l = sync.stamps[sync.stamps.length - 1];
  return l ? (l.e ?? l.s) : 0;
}
function press() {
  if (!sync || sync.holding || sync.stamps.length >= sync.lines.length) return;
  sync.stamps.push({ s: Math.max(lastTime(), now() - 0.05), e: null });
  sync.holding = true;
  writeSync();
}
function release() {
  if (!sync || !sync.holding) return;
  const st = sync.stamps[sync.stamps.length - 1];
  st.e = Math.max(st.s, now() - 0.05);
  sync.holding = false;
  writeSync();
}
function undoTap() {
  if (!sync || !sync.stamps.length) return;
  sync.holding = false;
  const removed = sync.stamps.pop();
  seekTo(Math.max(lastTime(), removed.s - 2));
  writeSync();
}
$("syncBtn").addEventListener("click", () => (sync ? stopSync() : startSync()));
$("tapBtn").addEventListener("pointerdown", (e) => { e.preventDefault(); press(); });
$("tapBtn").addEventListener("pointerup", release);
$("tapBtn").addEventListener("pointerleave", release);
window.addEventListener("keydown", (e) => {
  if (recording && e.code === "Escape") { e.preventDefault(); stopRecording(true); return; }
  if (!sync) return;
  if (e.code === "Space") { e.preventDefault(); if (!e.repeat) press(); }
  else if (e.code === "Backspace") { e.preventDefault(); undoTap(); }
  else if (e.code === "Escape") { e.preventDefault(); release(); stopSync(); }
});
window.addEventListener("keyup", (e) => {
  if (sync && e.code === "Space") { e.preventDefault(); release(); }
});

// ---------- record ----------
function pickMime() {
  return ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    .find((m) => MediaRecorder.isTypeSupported(m)) || "";
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startRecording() {
  if (sync) stopSync();
  const start = Math.max(0, parseClock(state.clipStart) ?? 0);
  const end = Math.min(duration || Infinity, parseClock(state.clipEnd) ?? (duration || Infinity));
  if (!(end > start)) { $("recStatus").textContent = "'To' must be after 'From'."; return; }
  await cueTo(start);
  document.body.classList.add("recording");
  try { await document.documentElement.requestFullscreen(); } catch (e) {}
  await sleep(600);
  placeStage();
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: (() => {
        const r = stage.getBoundingClientRect();
        const k = SW / r.width;
        return { frameRate: 30, cursor: "never", width: { ideal: Math.round(innerWidth * k) }, height: { ideal: Math.round(innerHeight * k) }, resizeMode: "crop-and-scale" };
      })(),
      audio: false,
      preferCurrentTab: true, selfBrowserSurface: "include", surfaceSwitching: "exclude",
    });
  } catch (e) {
    endRecordingUI();
    $("recStatus").textContent = "Recording was not allowed.";
    return;
  }
  const vt = stream.getVideoTracks()[0];
  const cs = vt.getSettings();
  if (cs.width) { capK = cs.width / innerWidth; placeStage(); await sleep(250); }
  try {
    if (window.CropTarget && vt.cropTo) await vt.cropTo(await CropTarget.fromElement(stage));
  } catch (e) { console.warn("crop failed", e); }
  const tracks = [vt];
  try {
    const m = webamp.media;
    if (!m._recDest) {
      m._recDest = m._context.createMediaStreamDestination();
      m._recGain = m._context.createGain();
      m._gainNode.connect(m._recGain); m._recGain.connect(m._recDest);
    }
    await m._context.resume();
    tracks.push(...m._recDest.stream.getAudioTracks());
  } catch (e) { console.warn("audio tap failed", e); }
  const noAudio = tracks.length < 2;
  const mixed = new MediaStream(tracks);
  const mime = pickMime();
  const rec = new MediaRecorder(mixed, { mimeType: mime, videoBitsPerSecond: 30_000_000, audioBitsPerSecond: 256_000 });
  const chunks = [];
  rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
  const fi = Math.max(0, Number(state.fadeIn) || 0), fo = Math.max(0, Number(state.fadeOut) || 0);
  rec.onstop = async () => {
    vt.stop();
    resetRecGain();
    if (recording && recording.cancelled) return;
    const type = mime.split(";")[0], ext = type === "video/mp4" ? "mp4" : "webm";
    const blob = new Blob(chunks, { type });
    const name = (state.title || "song").replace(/[\\/:*?"<>|]+/g, "_");
    const a = $("download");
    a.href = URL.createObjectURL(blob);
    a.download = name + "-raw." + ext;
    a.textContent = `Download raw recording (${(blob.size / 1e6).toFixed(1)} MB)`;
    a.hidden = false;
    if (noAudio) { $("recStatus").textContent = "Warning: no sound was captured."; return; }
    await finishOnServer(blob, { start, end, fi, fo, name });
  };
  recording = { rec, start, end, fi, fo, fading: false, cancelled: false };
  await sleep(300);
  rec.start(500);
  await sleep(200);
  const g = webamp.media._recGain;
  if (g && fi > 0) {
    const t0 = webamp.media._context.currentTime;
    g.gain.cancelScheduledValues(t0); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(1, t0 + fi);
  }
  play();
}
function resetRecGain() {
  try {
    const g = webamp.media._recGain, c = webamp.media._context;
    g.gain.cancelScheduledValues(c.currentTime); g.gain.setValueAtTime(1, c.currentTime);
  } catch (e) {}
}
async function finishOnServer(blob, p) {
  const st = $("recStatus");
  try {
    const ping = await fetch("api/ping");
    if (!ping.ok) throw new Error("no server");
  } catch (e) {
    st.textContent = "Done. Helper not running (start with run.sh), so use the raw download + convert.sh.";
    return;
  }
  if (!songFile) { st.textContent = "Load the song file again, then record."; return; }
  const id = Math.random().toString(36).slice(2, 10);
  try {
    st.textContent = "Sending to helper...";
    for (const [part, body] of [["video", blob], ["song", songFile]]) {
      const r = await fetch(`api/upload?id=${id}&part=${part}`, { method: "POST", body });
      if (!r.ok) throw new Error("upload failed");
    }
    const q = new URLSearchParams({ id, start: p.start.toFixed(3), end: p.end.toFixed(3), fi: p.fi, fo: p.fo, name: p.name, level: state.level || "player" });
    await fetch(`api/finish?${q}`, { method: "POST" });
    for (;;) {
      await sleep(700);
      const j = await (await fetch(`api/status?id=${id}`)).json();
      if (j.status === "done") { st.textContent = "Saved: " + j.path + (j.gain ? ` (volume ${j.gain} dB)` : "") + (j.size ? `, ${j.size}` : ""); break; }
      if (j.status === "error") { st.textContent = "Helper error: " + j.error + " (raw recording still downloadable)"; break; }
      st.textContent = j.status;
    }
  } catch (e) {
    st.textContent = "Could not finish: " + e.message;
  }
}
function endRecordingUI() {
  capK = 0;
  document.body.classList.remove("recording");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  setTimeout(placeStage, 300);
}
function stopRecording(cancelled) {
  const r = recording;
  if (!r) return;
  r.cancelled = cancelled;
  pause();
  setTimeout(() => { if (r.rec.state !== "inactive") r.rec.stop(); recording = null; }, cancelled ? 0 : 250);
  endRecordingUI();
  $("recStatus").textContent = cancelled ? "Cancelled." : "Saving...";
}
$("recBtn").addEventListener("click", startRecording);

// ---------- loop ----------
function loop() {
  syncClock();
  const t = now();
  drawLyrics();
  drawArt();
  $("clock").textContent = fmt(t) + " / " + fmt(duration);
  if (!seeking && duration) $("seek").value = Math.round((t / duration) * 1000);
  $("playBtn").textContent = clock.playing ? "Pause" : "Play";
  if (recording && !recording.cancelled && recording.fo > 0 && !recording.fading && t >= recording.end - recording.fo) {
    recording.fading = true;
    try {
      const g = webamp.media._recGain, c = webamp.media._context;
      g.gain.cancelScheduledValues(c.currentTime); g.gain.setValueAtTime(g.gain.value, c.currentTime);
      g.gain.linearRampToValueAtTime(0, c.currentTime + Math.max(0.05, recording.end - t));
    } catch (e) {}
  }
  if (recording && !recording.cancelled && (t >= recording.end || (duration && t >= duration - 0.05 && !clock.playing && t > recording.start + 1))) stopRecording(false);
  requestAnimationFrame(loop);
}

async function init() {
  load();
  $("title").value = state.title; $("artist").value = state.artist;
  $("lyrics").value = state.lyrics; $("offset").value = state.offset;
  $("helper").value = state.helper;
  $("sweep").checked = state.sweep; if (!ASPECTS[state.aspect]) state.aspect = "1:1";
  $("aspectSel").value = state.aspect;
  fillLayoutSel();
  $("bgMode").value = state.bgMode === "image" ? "color" : state.bgMode;
  state.bgMode = $("bgMode").value;
  $("bgColor").value = state.bgColor;
  $("clipStart").value = state.clipStart; $("clipEnd").value = state.clipEnd;
  $("fadeIn").value = state.fadeIn; $("fadeOut").value = state.fadeOut;
  $("level").value = ["player", "youtube", "original"].includes(state.level) ? state.level : "player";
  if (![...$("skinSel").options].some((o) => o.value === state.skin)) state.skin = "skins/classic.wsz";
  $("skinSel").value = state.skin;
  timed = parseLyrics(state.lyrics);
  try {
    const ff = await new FontFace("DotGothic16", "url(fonts/DotGothic16.ttf)").load();
    document.fonts.add(ff);
  } catch (e) {}
  layoutWindows(); placeStage(); drawWall();
  window.addEventListener("resize", placeStage);
  document.addEventListener("fullscreenchange", () => setTimeout(placeStage, 100));
  try { fallbackParts = await parseSkin(await (await fetch("skins/classic.wsz")).blob()); } catch (e) {}
  await setSkin(state.skin);
  await startWebamp();
  requestAnimationFrame(loop);
}
init();
