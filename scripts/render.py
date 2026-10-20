#!/usr/bin/env python3
"""Turns a recording folder (frames + timeline.json) into a video in the fixed style.

Effects applied (all configured in config/style.json):
  - A rounded, shadowed browser window on a gradient background
  - Automatic zoom in / pan / zoom out driven by the actions (smooth easing)
  - A synthetic cursor built from the recorded mouse moves, with a press effect
  - Click rings (ripple)
  - Step captions (language from the storyboard / style.json)
  - Title card + soft fade out
  - Synthesized click / whoosh sounds and the fixed music bed (no licensing issues)
  - Compressed waits (page loads) and sped-up typing

Usage:
  python3 scripts/render.py <recording_dir> -o video.mp4 [--style override.json] [--gif] [--stills dir]
"""
import argparse
import json
import math
import re
import os
import subprocess
import sys
import wave
from collections import OrderedDict

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(SKILL_DIR, "assets", "fonts")
SS = 2  # supersampling factor for the static layers


# ------------------------------------------------------------------ helpers
def ease(x):
    x = min(1.0, max(0.0, x))
    return 4 * x * x * x if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_out(x):
    x = min(1.0, max(0.0, x))
    return 1 - (1 - x) ** 3


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def hex_bgr(h):
    r, g, b = hex_rgb(h)
    return (b, g, r)


def deep_merge(base, over):
    if over is None:
        return base
    if not isinstance(base, dict) or not isinstance(over, dict):
        return over
    out = dict(base)
    for k, v in over.items():
        out[k] = deep_merge(base.get(k), v)
    return out


def font(weight, size):
    name = {"bold": "Inter-Bold.otf", "semibold": "Inter-SemiBold.otf", "medium": "Inter-Medium.otf"}[weight]
    path = os.path.join(FONT_DIR, name)
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default(size)


def gradient(w, h, c_from, c_to, angle_deg):
    a = math.radians(angle_deg)
    dx, dy = math.sin(a), -math.cos(a)  # CSS gradient direction
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    proj = (xs - w / 2) * dx + (ys - h / 2) * dy
    half = abs(w / 2 * dx) + abs(h / 2 * dy)
    t = np.clip((proj / half + 1) / 2, 0, 1)[..., None]
    c0 = np.array(hex_bgr(c_from), np.float32)
    c1 = np.array(hex_bgr(c_to), np.float32)
    img = c0 * (1 - t) + c1 * t
    # subtle vignette
    r = np.sqrt(((xs - w / 2) / (w / 2)) ** 2 + ((ys - h / 2) / (h / 2)) ** 2)[..., None]
    img *= 1 - 0.18 * np.clip(r - 0.4, 0, 1)
    return np.clip(img, 0, 255).astype(np.uint8)


def rounded_mask(w, h, rect, radius, corners=(True, True, True, True), scale=1):
    """rect=(x0,y0,x1,y1) -> uint8 maske. corners: (top-left, top-right, bottom-right, bottom-left)."""
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([round(v) for v in rect], radius=round(radius), fill=255, corners=corners)
    return np.array(m)


def alpha_blend_patch(dst, x, y, rgba, alpha_mul=1.0):
    """Alpha-blends a BGRA patch (uint8) onto dst with its top-left corner at (x, y)."""
    h, w = rgba.shape[:2]
    H, W = dst.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    sub = rgba[y0 - y:y1 - y, x0 - x:x1 - x]
    a = sub[..., 3:4].astype(np.float32) * (alpha_mul / 255.0)
    region = dst[y0:y1, x0:x1].astype(np.float32)
    dst[y0:y1, x0:x1] = (region * (1 - a) + sub[..., :3].astype(np.float32) * a).astype(np.uint8)


def pil_to_bgra(img):
    arr = np.array(img.convert("RGBA"))
    return arr[..., [2, 1, 0, 3]].copy()


# ------------------------------------------------------------------ time mapping
class TimeMap:
    """Source (recording) time <-> content output time. Compresses waits, speeds up typing."""

    def __init__(self, events, t_start, t_end, pacing):
        segs = []
        max_wait = pacing["maxWaitMs"] / 1000
        for e in events:
            if e["type"] == "wait":
                d = e["t1"] - e["t0"]
                if d > max_wait:
                    segs.append((e["t0"] - t_start, e["t1"] - t_start, d / max_wait))
            elif e["type"] == "type":
                d = e["t1"] - e["t0"]
                if d > 0.08:
                    segs.append((e["t0"] - t_start, e["t1"] - t_start, pacing["typeSpeedup"]))
        end = t_end - t_start
        bounds = sorted({0.0, end, *[min(end, max(0, s[0])) for s in segs], *[min(end, max(0, s[1])) for s in segs]})
        src, out = [bounds[0]], [0.0]
        for a, b in zip(bounds[:-1], bounds[1:]):
            mid = (a + b) / 2
            sp = max([s[2] for s in segs if s[0] <= mid < s[1]], default=1.0)
            src.append(b)
            out.append(out[-1] + (b - a) / sp)
        self.src = np.array(src)
        self.out = np.array(out)
        self.t_start = t_start
        self.duration = float(self.out[-1])

    def to_out(self, t_abs):
        return float(np.interp(t_abs - self.t_start, self.src, self.out))

    def to_src(self, u):
        return float(np.interp(u, self.out, self.src)) + self.t_start


# ------------------------------------------------------------------ scene geometry
class Scene:
    def __init__(self, style, viewport, frame_size):
        o = style["output"]
        fr = style["frame"]
        self.W, self.H = o["width"], o["height"]
        self.vw, self.vh = viewport["width"], viewport["height"]
        self.fw, self.fh = frame_size
        pad = fr["padding"]
        bar = fr["browserBar"]["height"] if fr["browserBar"]["enabled"] else 0
        # captionSpace: a band at the bottom reserved for captions (in vertical the window fills the screen)
        cs = fr.get("captionSpace", 0)
        ch = self.H - cs - 2 * pad - bar
        cw = ch * self.vw / self.vh
        if cw > self.W - 2 * pad:
            cw = self.W - 2 * pad
            ch = cw * self.vh / self.vw
        self.cw, self.ch, self.bar = cw, ch, bar
        self.wx0 = (self.W - cw) / 2
        self.wy0 = (self.H - cs - (ch + bar)) / 2
        self.cx0, self.cy0 = self.wx0, self.wy0 + bar
        self.full = (self.W / 2, self.H / 2, 1.0)

    def css_to_scene(self, x, y):
        return self.cx0 + x * self.cw / self.vw, self.cy0 + y * self.ch / self.vh

    def box_to_scene(self, b):
        x0, y0 = self.css_to_scene(b["x"], b["y"])
        x1, y1 = self.css_to_scene(b["x"] + b["w"], b["y"] + b["h"])
        return x0, y0, x1, y1

    def to_out(self, px, py, cam):
        cx, cy, s = cam
        return (px - cx) * s + self.W / 2, (py - cy) * s + self.H / 2

    def focus_cam(self, box, cam_cfg):
        x0, y0, x1, y1 = self.box_to_scene(box)
        pad = cam_cfg["focusPadding"]
        s = min(cam_cfg["maxZoom"], self.W / (x1 - x0 + 2 * pad), self.H / (y1 - y0 + 2 * pad))
        if s < cam_cfg["minZoom"]:
            return None
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        hw, hh = self.W / (2 * s), self.H / (2 * s)
        # If the view fits inside the window, don't let it drift outside (onto the background)
        wx0, wx1 = self.wx0, self.wx0 + self.cw
        wy0, wy1 = self.wy0, self.cy0 + self.ch
        lo_x, hi_x = (wx0 + hw, wx1 - hw) if 2 * hw <= wx1 - wx0 else (hw, self.W - hw)
        lo_y, hi_y = (wy0 + hh, wy1 - hh) if 2 * hh <= wy1 - wy0 else (hh, self.H - hh)
        cx = min(max(cx, lo_x), hi_x)
        cy = min(max(cy, lo_y), hi_y)
        return (cx, cy, s)


# ------------------------------------------------------------------ camera
class Camera:
    def __init__(self, scene, events, tmap, cam_cfg):
        self.scene = scene
        full = scene.full
        foc = []
        for e in events:
            if e["type"] != "focus":
                continue
            cam = scene.focus_cam(e["box"], cam_cfg)
            if cam is None:
                continue
            foc.append((tmap.to_out(e["t0"]), tmap.to_out(e["t1"]), cam))
        foc.sort(key=lambda f: f[0])

        zin, zout, pan = cam_cfg["zoomInMs"] / 1000, cam_cfg["zoomOutMs"] / 1000, cam_cfg["panMs"] / 1000
        linger, join = cam_cfg["lingerMs"] / 1000, cam_cfg["joinGapMs"] / 1000
        groups = []
        for f in foc:
            if groups and f[0] - groups[-1][-1][1] <= join:
                groups[-1].append(f)
            else:
                groups.append([f])

        keys = [(0.0, full)]

        def add(t, cam):
            t = max(t, keys[-1][0])
            keys.append((t, cam))

        self.transitions = []  # (time, kind) -> for the sound effects
        for g in groups:
            add(g[0][0], keys[-1][1])
            self.transitions.append((keys[-1][0], "zoom"))
            add(g[0][0] + zin, g[0][2])
            for f in g[1:]:
                add(f[0], keys[-1][1])
                self.transitions.append((keys[-1][0], "pan"))
                add(f[0] + pan, f[2])
            end = g[-1][1] + linger
            add(end, keys[-1][1])
            self.transitions.append((keys[-1][0], "zoom"))
            add(end + zout, full)
        self.keys = keys
        self.times = np.array([k[0] for k in keys])

    def at(self, u):
        i = int(np.searchsorted(self.times, u, side="right")) - 1
        if i < 0:
            return self.keys[0][1]
        if i >= len(self.keys) - 1:
            return self.keys[-1][1]
        (t0, c0), (t1, c1) = self.keys[i], self.keys[i + 1]
        if c0 == c1 or t1 <= t0:
            return c0
        f = ease((u - t0) / (t1 - t0))
        s = math.exp(math.log(c0[2]) * (1 - f) + math.log(c1[2]) * f)
        return (c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, s)


# ------------------------------------------------------------------ static layers
def short_url(url, display=None):
    """Address bar text: the scheme is dropped. If display is given (e.g. "app.example.com"),
    it replaces the real origin (localhost:3005); path and query are kept."""
    for p in ("https://", "http://"):
        if url.startswith(p):
            url = url[len(p):]
    if display:
        for p in ("https://", "http://"):
            if display.startswith(p):
                display = display[len(p):]
        slash = url.find("/")
        url = display.rstrip("/") + (url[slash:] if slash >= 0 else "")
    return url


def build_base_layers(scene, style, urls):
    """Per URL: background + shadow + window/top bar, at 2x resolution and downscaled to 1x."""
    fr = style["frame"]
    W2, H2 = scene.W * SS, scene.H * SS
    bg = gradient(W2, H2, fr["background"]["from"], fr["background"]["to"], fr["background"]["angle"])

    win = (scene.wx0 * SS, scene.wy0 * SS, (scene.wx0 + scene.cw) * SS, (scene.cy0 + scene.ch) * SS)
    r = fr["cornerRadius"] * SS
    sh = fr["shadow"]
    off = sh["offsetY"] * SS
    shadow = rounded_mask(W2, H2, (win[0], win[1] + off, win[2], win[3] + off), r).astype(np.float32) / 255
    k = int(sh["blur"] * SS) | 1
    shadow = cv2.GaussianBlur(shadow, (0, 0), sigmaX=sh["blur"] * SS / 2)
    base = (bg.astype(np.float32) * (1 - shadow[..., None] * sh["opacity"])).astype(np.uint8)

    content_mask = rounded_mask(W2, H2, win, r, corners=(scene.bar == 0, scene.bar == 0, True, True))
    content_mask[: int(scene.cy0 * SS), :] = 0  # the bar area is not content

    layers = {}
    bb = fr["browserBar"]
    for url in urls:
        img = Image.fromarray(cv2.cvtColor(base, cv2.COLOR_BGR2RGB))
        d = ImageDraw.Draw(img)
        # window body (bar included); content goes on top
        d.rounded_rectangle([round(v) for v in win], radius=round(r), fill=hex_rgb(bb["color"]) if scene.bar else (255, 255, 255))
        if scene.bar:
            bh = scene.bar * SS
            y_mid = win[1] + bh / 2
            for i, c in enumerate(bb["dots"]):
                cx = win[0] + (18 + i * 20) * SS
                d.ellipse([cx - 6 * SS, y_mid - 6 * SS, cx + 6 * SS, y_mid + 6 * SS], fill=hex_rgb(c))
            uw = min(scene.cw * 0.5, 720) * SS
            ux0 = (win[0] + win[2]) / 2 - uw / 2
            d.rounded_rectangle([ux0, y_mid - 13 * SS, ux0 + uw, y_mid + 13 * SS], radius=8 * SS, fill=hex_rgb(bb["urlBg"]))
            f = font("medium", 14 * SS)
            text = short_url(url, bb.get("displayUrl"))
            while d.textlength(text, font=f) > uw - 40 * SS and len(text) > 4:
                text = text[:-2] + "…" if not text.endswith("…") else text[:-3] + "…"
            tw = d.textlength(text, font=f)
            d.text(((win[0] + win[2]) / 2 - tw / 2, y_mid), text, font=f, fill=hex_rgb(bb["textColor"]), anchor="lm")
        arr = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
        layers[url] = (cv2.resize(arr, (scene.W, scene.H), interpolation=cv2.INTER_AREA), arr)
    masks = (cv2.resize(content_mask, (scene.W, scene.H), interpolation=cv2.INTER_AREA), content_mask)
    bg1 = cv2.resize(bg, (scene.W, scene.H), interpolation=cv2.INTER_AREA)
    return layers, masks, bg1


def make_cursor_sprite(style, px=128):
    """Arrow cursor sprite (BGRA), hotspot at the top-left tip. With a shadow."""
    c = style["cursor"]
    S = 4
    w, h = int(px * 0.75), px
    pad = 24
    img = Image.new("RGBA", ((w + 2 * pad) * S, (h + 2 * pad) * S), (0, 0, 0, 0))
    pts_n = [(0, 0), (0, 0.80), (0.21, 0.63), (0.34, 0.93), (0.47, 0.87), (0.35, 0.58), (0.60, 0.58)]
    pts = [((pad + x * h) * S, (pad + y * h) * S) for x, y in pts_n]
    # shadow
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + 4 * S, y + 7 * S) for x, y in pts], fill=(0, 0, 0, 110))
    sh_arr = cv2.GaussianBlur(np.array(sh), (0, 0), sigmaX=5 * S)
    img = Image.alpha_composite(img, Image.fromarray(sh_arr))
    d = ImageDraw.Draw(img)
    ow = 9 * S
    d.polygon(pts, fill=hex_rgb(c["outline"]))
    d.line(pts + [pts[0]], fill=hex_rgb(c["outline"]), width=ow, joint="curve")
    for p in pts:
        d.ellipse([p[0] - ow / 2, p[1] - ow / 2, p[0] + ow / 2, p[1] + ow / 2], fill=hex_rgb(c["outline"]))
    d.polygon(pts, fill=hex_rgb(c["fill"]))
    img = img.resize((w + 2 * pad, h + 2 * pad), Image.LANCZOS)
    return pil_to_bgra(img), (pad, pad), h


def wrap_lines(text, f, max_w, draw):
    words, lines, cur = text.split(), [], ""
    for wd in words:
        cand = (cur + " " + wd).strip()
        if draw.textlength(cand, font=f) <= max_w or not cur:
            cur = cand
        else:
            lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines


def make_caption_sprite(text, style, out_w):
    c = style["captions"]
    S = 2
    f = font("semibold", c["fontSize"] * S)
    # in vertical/square output maxWidth can be wider than the screen
    max_w = min(c["maxWidth"], out_w - 2 * style["frame"]["padding"]) * S - 2 * c["paddingX"] * S
    tmp = ImageDraw.Draw(Image.new("L", (1, 1)))
    lines = wrap_lines(text, f, max_w, tmp)
    lh = int(c["fontSize"] * S * 1.3)
    tw = max(tmp.textlength(l, font=f) for l in lines)
    w = int(tw + 2 * c["paddingX"] * S)
    h = int(lh * len(lines) + 2 * c["paddingY"] * S)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=c["radius"] * S, fill=hex_rgb(c["bgColor"]) + (int(255 * c["bgOpacity"]),))
    for i, l in enumerate(lines):
        lw = d.textlength(l, font=f)
        d.text(((w - lw) / 2, c["paddingY"] * S + lh * i + lh / 2), l, font=f, fill=hex_rgb(c["textColor"]) + (255,), anchor="lm")
    img = img.resize((w // S, h // S), Image.LANCZOS)
    return pil_to_bgra(img)


def make_title_card(scene, style, title, subtitle, kicker):
    fr = style["frame"]
    bg = gradient(scene.W, scene.H, fr["background"]["from"], fr["background"]["to"], fr["background"]["angle"])
    img = Image.fromarray(cv2.cvtColor(bg, cv2.COLOR_BGR2RGB)).convert("RGBA")
    S = 2
    big = Image.new("RGBA", (scene.W * S, scene.H * S), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    fk = font("semibold", 30 * S)
    fs = font("medium", 28 * S)
    cx, cy = scene.W * S / 2, scene.H * S / 2
    # title: at most 3 lines, shrinks if it doesn't fit (vertical/square output, long titles)
    max_w = scene.W * 0.84 * S
    size = 88
    while True:
        ft = font("bold", size * S)
        lines = wrap_lines(title, ft, max_w, d)
        if (len(lines) <= 3 and all(d.textlength(l, font=ft) <= max_w for l in lines)) or size <= 40:
            break
        size -= 6
    lh = size * 1.18 * S
    block = lh * len(lines)
    for i, l in enumerate(lines):
        d.text((cx, cy - block / 2 + lh * (i + 0.5)), l, font=ft, fill=(255, 255, 255, 255), anchor="mm")
    if kicker:
        d.text((cx, cy - block / 2 - 46 * S), kicker, font=fk, fill=(199, 210, 254, 255), anchor="mm")
    if subtitle:
        d.text((cx, cy + block / 2 + 40 * S), subtitle, font=fs, fill=(255, 255, 255, 170), anchor="mm")
    big = big.resize((scene.W, scene.H), Image.LANCZOS)
    img = Image.alpha_composite(img, big)
    return cv2.cvtColor(np.array(img.convert("RGB")), cv2.COLOR_RGB2BGR), bg


# ------------------------------------------------------------------ audio
def synth_click(sr, rng):
    n = int(0.05 * sr)
    t = np.arange(n) / sr
    noise = np.diff(rng.standard_normal(n + 1))
    s = 0.25 * noise * np.exp(-t * 220)
    s += 0.55 * np.sin(2 * np.pi * 2100 * t) * np.exp(-t * 300)
    s += 0.45 * np.sin(2 * np.pi * 950 * t) * np.exp(-t * 140)
    return s / np.max(np.abs(s)) * 0.9


def synth_whoosh(sr, rng, dur=0.42):
    n = int(dur * sr)
    x = np.linspace(0, 1, n)
    noise = rng.standard_normal(n)
    # a low-pass filter that opens and closes over time (simple one-pole)
    cutoff = 220 + 1300 * np.sin(np.pi * np.clip(x / 0.9, 0, 1)) ** 2
    a = np.exp(-2 * np.pi * cutoff / sr)
    y = np.zeros(n)
    acc = 0.0
    for i in range(n):
        acc = a[i] * acc + (1 - a[i]) * noise[i]
        y[i] = acc
    env = np.sin(np.pi * np.clip(x, 0, 1) ** 0.8) ** 2
    y = y * env
    return y / (np.max(np.abs(y)) + 1e-9) * 0.8


def pick_sound_clicks(events, sfx, submit_words):
    """Which clicks make a sound? sfx.clicks: submit (default) | actions | all | none.

    submit: only the click that submits a form (a real submit button, or a button whose name
    contains one of submitWords). If none is found, the last button click. A step's
    `sound: true/false` always wins. Clicking fields (type/select) only sounds in `all` mode.
    """
    mode = sfx.get("clicks", "submit")
    words = [w.lower() for w in submit_words]
    items, step = [], None
    for e in events:
        if e["type"] == "step":
            step = e
        elif e["type"] == "click":
            # older timelines have no kind: infer it from the step's action
            kind = e.get("kind") or ("field" if step and step.get("action") in ("type", "select") else "action")
            items.append((e, kind, step.get("sound") if step else None))

    def is_submit(e):
        name = (e.get("name") or "").lower()
        return bool(e.get("submit")) or any(re.search(r"(^|\s)" + re.escape(w) + r"($|\s)", name) for w in words)

    chosen = []
    for e, kind, override in items:
        if override is not None:
            ok = bool(override)
        elif mode == "all":
            ok = True
        elif mode == "actions":
            ok = kind == "action"
        elif mode == "submit":
            ok = kind == "action" and is_submit(e)
        else:
            ok = False
        if ok:
            chosen.append(e)
    if mode == "submit" and not chosen and not any(o for _, _, o in items):
        actions = [e for e, kind, o in items if kind == "action" and o is None]
        chosen = actions[-1:]
    return chosen


MUSIC_PATH = os.path.join(SKILL_DIR, "assets", "music", "theme.m4a")


def load_music(sr):
    """The skill's single music track (made by scripts/make_music.py), decoded to stereo float by ffmpeg."""
    if not os.path.exists(MUSIC_PATH):
        print(f"WARNING: music file missing ({MUSIC_PATH}); continuing without music.", flush=True)
        return None
    raw = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", MUSIC_PATH, "-f", "f32le", "-ac", "2", "-ar", str(sr), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).astype(np.float64)


def music_bed(n, sr, cfg):
    """Extends the loop to n samples (the track loops seamlessly), with soft fades in and out."""
    loop = load_music(sr)
    if loop is None:
        return np.zeros((n, 2))
    bed = np.tile(loop, (n // len(loop) + 1, 1))[:n]
    t = np.arange(n) / sr
    fin, fout = cfg.get("fadeInMs", 800) / 1000, cfg.get("fadeOutMs", 1800) / 1000
    env = np.minimum(1, t / max(fin, 1e-3)) * np.clip((n / sr - t) / max(fout, 1e-3), 0, 1)
    env = env ** 1.5  # sounds more natural than a linear fade
    return bed * env[:, None] * cfg.get("volume", 0.4)


def build_audio(path, duration, clicks, whooshes, style, sr=48000):
    sfx = style["sfx"]
    total = int((duration + 0.5) * sr)
    mix = np.zeros(total)
    if sfx["enabled"]:
        rng = np.random.default_rng(7)
        click = synth_click(sr, rng) * sfx["clickVolume"]
        whoosh = synth_whoosh(sr, rng) * sfx["whooshVolume"]
        for t in clicks:
            i = int(t * sr)
            seg = click[: max(0, min(len(click), total - i))]
            mix[i:i + len(seg)] += seg
        for t, vol in whooshes:
            i = int((t - 0.06) * sr)
            if i < 0:
                continue
            seg = whoosh[: max(0, min(len(whoosh), total - i))] * vol
            mix[i:i + len(seg)] += seg
    stereo = np.repeat(mix[:, None], 2, axis=1)
    music = style.get("music", {})
    if music.get("enabled", True):
        # fade out by the real end of the video (the audio is 0.5 s longer)
        n_music = int(duration * sr)
        stereo[:n_music] += music_bed(n_music, sr, music)
    stereo = np.tanh(stereo * 1.1)
    stereo = (stereo * 32767 * 0.95).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(stereo.tobytes())


# ------------------------------------------------------------------ render
class FrameSource:
    def __init__(self, rec_dir, frames):
        self.dir = os.path.join(rec_dir, "frames")
        self.files = [f["f"] for f in frames]
        self.times = np.array([f["t"] for f in frames])
        self.cache = OrderedDict()

    def index_at(self, t_abs):
        return max(0, int(np.searchsorted(self.times, t_abs, side="right")) - 1)

    def get(self, idx):
        if idx in self.cache:
            self.cache.move_to_end(idx)
            return self.cache[idx]
        full = cv2.imread(os.path.join(self.dir, self.files[idx]), cv2.IMREAD_COLOR)
        half = cv2.resize(full, (full.shape[1] // 2, full.shape[0] // 2), interpolation=cv2.INTER_AREA)
        self.cache[idx] = (full, half)
        if len(self.cache) > 6:
            self.cache.popitem(last=False)
        return self.cache[idx]


def affine(scale_px, origin_scene, cam, W, H):
    """Layer pixel p -> output pixel. scale_px: scene units per layer pixel."""
    cx, cy, s = cam
    a = s * scale_px
    tx = a * 0.5 + s * (origin_scene[0] - cx) + W / 2 - 0.5
    ty = a * 0.5 + s * (origin_scene[1] - cy) + H / 2 - 0.5
    return np.float32([[a, 0, tx], [0, a, ty]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rec_dir")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--style", help="Partial style override JSON for rendering only (no re-recording needed)")
    ap.add_argument("--gif", action="store_true", help="Also write a GIF")
    ap.add_argument("--stills", help="Write a few frames as PNG to this folder for checking")
    args = ap.parse_args()

    tl_path = os.path.join(args.rec_dir, "timeline.json")
    if not os.path.exists(tl_path):
        # record.mjs deletes the old timeline when it starts; if it's missing, the last recording failed
        sys.exit(f"ERROR: {tl_path} not found. Nothing was recorded or the last recording failed; run record.mjs successfully first.")
    tl = json.load(open(tl_path, encoding="utf-8"))
    style = tl["style"]
    if args.style:
        style = deep_merge(style, json.load(open(args.style, encoding="utf-8")))
    events = tl["events"]
    o = style["output"]
    W, H, fps = o["width"], o["height"], o["fps"]
    frame_size = tl.get("frameSize") or [tl["viewport"]["width"] * tl["dpr"], tl["viewport"]["height"] * tl["dpr"]]

    scene = Scene(style, tl["viewport"], frame_size)
    tmap = TimeMap(events, tl["tStart"], tl["tEnd"], style["pacing"])
    camera = Camera(scene, events, tmap, style["camera"])
    src = FrameSource(args.rec_dir, tl["frames"])

    # URLs
    url_events = sorted([(e["t"], e["url"]) for e in events if e["type"] == "url"])
    if not url_events:
        url_events = [(tl["tStart"], tl.get("baseUrl", ""))]
    url_times = np.array([u[0] for u in url_events])
    layers, masks, _ = build_base_layers(scene, style, sorted({u[1] for u in url_events}))

    # cursor
    cursor_sprite, hotspot, cursor_h = make_cursor_sprite(style)
    moves = sorted([e for e in events if e["type"] == "move"], key=lambda e: e["t0"])
    clicks = [e for e in events if e["type"] == "click"]

    def cursor_at(t_abs):
        pos = None
        for m in moves:
            if m["t0"] > t_abs:
                break
            if t_abs >= m["t1"] or m["t1"] <= m["t0"]:
                pos = m["to"]
            else:
                f = ease((t_abs - m["t0"]) / (m["t1"] - m["t0"]))
                pos = [m["from"][0] + (m["to"][0] - m["from"][0]) * f, m["from"][1] + (m["to"][1] - m["from"][1]) * f]
        if pos is None:
            pos = moves[0]["from"] if moves else [scene.vw / 2, scene.vh / 2]
        return pos

    # captions: from a step with a caption until the next one
    caps = []
    for e in events:
        if e["type"] == "step" and e.get("caption") is not None:
            text = str(e["caption"]).strip()
            if caps and caps[-1][1] == text:
                continue
            caps.append((tmap.to_out(e["t"]), text))
    cap_sprites = {t: make_caption_sprite(t, style, W) for _, t in caps if t} if style["captions"]["enabled"] else {}

    # timeline: title card + content + fade out
    tc = style["titleCard"]
    lang = style.get("language", "en")
    kicker = style.get("i18n", {}).get(lang, {}).get("kicker")
    title_img, bg_screen = make_title_card(scene, style, tl["title"], tl.get("subtitle"), kicker)
    T_title = tc["durationMs"] / 1000 if tc["enabled"] else 0
    T_tr = min(tc["transitionMs"] / 1000, T_title) if tc["enabled"] else 0
    C0 = T_title - T_tr
    content_dur = tmap.duration
    total = C0 + content_dur
    n_frames = int(math.ceil(total * fps))
    fade_out = style["outro"]["fadeMs"] / 1000
    print(f"Render: {n_frames} frames, {total:.1f} s (raw recording {tl['tEnd'] - tl['tStart']:.1f} s)", flush=True)

    # audio
    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    wav = os.path.join(args.rec_dir, "sfx.wav")
    sfx_cfg = style["sfx"]
    submit_words = style.get("i18n", {}).get(lang, {}).get("submitWords", [])
    click_times = [C0 + tmap.to_out(c["t"]) for c in pick_sound_clicks(events, sfx_cfg, submit_words)]
    # whoosh: intro (default, only the title card transition) | all (every zoom/pan) | none
    whoosh_mode = sfx_cfg.get("whoosh", "intro")
    whooshes = []
    if whoosh_mode == "all":
        whooshes = [(C0 + t, 1.0 if kind == "zoom" else 0.6) for t, kind in camera.transitions]
    if tc["enabled"] and whoosh_mode in ("all", "intro"):
        whooshes.append((C0, 0.5))
    build_audio(wav, total, click_times, whooshes, style)

    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", str(fps), "-i", "-",
         "-i", wav, "-c:v", "libx264", "-preset", "medium", "-crf", str(o["crf"]), "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", args.output],
        stdin=subprocess.PIPE,
    )

    still_times = set()
    if args.stills:
        os.makedirs(args.stills, exist_ok=True)
        # don't mix in frames from an earlier render; only delete files we wrote
        for name in os.listdir(args.stills):
            if name.startswith("still_") and name.endswith(".png"):
                os.remove(os.path.join(args.stills, name))
        for t, _ in camera.keys:
            still_times.add(int((C0 + t + 0.05) * fps))
        for t, _ in caps:
            still_times.add(int((C0 + t + 0.4) * fps))
        still_times.update({int(T_title * 0.6 * fps), int((C0 + T_tr * 0.5) * fps), n_frames - int(fade_out * fps) - 2})

    cfg_c = style["cursor"]
    cfg_k = style["click"]
    cap_cfg = style["captions"]
    zs = cfg_c["zoomScaling"]

    for fi in range(n_frames):
        t = fi / fps
        u = t - C0
        if u < 0:
            frame = title_img.copy()
            a_in = ease(t / 0.35)
            if a_in < 1:
                frame = cv2.addWeighted(bg_screen, 1 - a_in, title_img, a_in, 0)
        else:
            cam = camera.at(u)
            mix = 1.0
            if tc["enabled"] and u < T_tr:
                q = ease(u / T_tr)
                cam = (cam[0], cam[1], cam[2] * (0.92 + 0.08 * q))
                mix = q
            cx, cy, s = cam
            t_abs = tmap.to_src(u)

            # base: background + window (2x or 1x layer)
            ui = max(0, int(np.searchsorted(url_times, t_abs, side="right")) - 1)
            l1, l2 = layers[url_events[ui][1]]
            if s >= 1.5:
                base_l, mask_l, sp = l2, masks[1], 1 / SS
            else:
                base_l, mask_l, sp = l1, masks[0], 1.0
            Mb = affine(sp, (0, 0), cam, W, H)
            frame = cv2.warpAffine(base_l, Mb, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            m = cv2.warpAffine(mask_l, Mb, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)

            # content
            full, half = src.get(src.index_at(t_abs))
            k0 = scene.cw / full.shape[1]
            if s * k0 >= 0.75:
                img, k = full, k0
            else:
                img, k = half, scene.cw / half.shape[1]
            Mc = affine(k, (scene.cx0, scene.cy0), cam, W, H)
            cont = cv2.warpAffine(img, Mc, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            ys, xs = np.nonzero(m)
            if len(xs):
                y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
                mm = m[y0:y1, x0:x1, None].astype(np.uint16)
                frame[y0:y1, x0:x1] = ((frame[y0:y1, x0:x1].astype(np.uint16) * (255 - mm) + cont[y0:y1, x0:x1].astype(np.uint16) * mm + 127) // 255).astype(np.uint8)

            # click rings
            zf = s ** zs
            for c in clicks:
                dt = u - tmap.to_out(c["t"])
                if 0 <= dt < cfg_k["durationMs"] / 1000:
                    kk = dt / (cfg_k["durationMs"] / 1000)
                    px, py = scene.to_out(*scene.css_to_scene(c["x"], c["y"]), cam)
                    rad = max(2.0, cfg_k["maxRadius"] * zf * (0.25 + 0.75 * ease_out(kk)))
                    col = hex_bgr(cfg_k["color"])
                    R = int(rad + 6)
                    ix, iy = int(px), int(py)
                    x0, y0, x1, y1 = max(0, ix - R), max(0, iy - R), min(W, ix + R + 1), min(H, iy + R + 1)
                    if x1 > x0 and y1 > y0:
                        roi = frame[y0:y1, x0:x1]
                        ov = roi.copy()
                        center = (int((px - x0) * 16), int((py - y0) * 16))
                        cv2.circle(ov, center, int(rad * 16), col, -1, cv2.LINE_AA, shift=4)
                        a_fill = 0.35 * (1 - kk)
                        roi[:] = cv2.addWeighted(ov, a_fill, roi, 1 - a_fill, 0)
                        ov = roi.copy()
                        cv2.circle(ov, center, int(rad * 16), col, max(2, int(3 * zf)), cv2.LINE_AA, shift=4)
                        a_ring = 0.9 * (1 - kk)
                        roi[:] = cv2.addWeighted(ov, a_ring, roi, 1 - a_ring, 0)

            # cursor
            cxp, cyp = cursor_at(t_abs)
            px, py = scene.to_out(*scene.css_to_scene(cxp, cyp), cam)
            press = 1.0
            for c in clicks:
                dt = t_abs - c["t"]
                pm = cfg_c["pressMs"] / 1000
                if -0.05 <= dt < pm:
                    press = 1 - (1 - cfg_c["pressScale"]) * math.sin(math.pi * min(1, max(0, (dt + 0.05) / (pm + 0.05))))
            size = cfg_c["size"] * zf * press
            sc = size / cursor_h
            ch_, cw_ = cursor_sprite.shape[:2]
            ox, oy = px - hotspot[0] * sc, py - hotspot[1] * sc
            ix, iy = int(math.floor(ox)), int(math.floor(oy))
            pw, ph = int(cw_ * sc) + 3, int(ch_ * sc) + 3
            Ms = np.float32([[sc, 0, ox - ix], [0, sc, oy - iy]])
            patch = cv2.warpAffine(cursor_sprite, Ms, (pw, ph), flags=cv2.INTER_LINEAR if sc >= 0.5 else cv2.INTER_AREA,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
            alpha_blend_patch(frame, ix, iy, patch)

            # title card transition: the text fades first, then the window emerges from the background
            if mix < 1:
                ta = 1 - ease(min(1.0, (u / T_tr) * 2))
                under = cv2.addWeighted(title_img, ta, bg_screen, 1 - ta, 0) if ta > 0 else bg_screen
                frame = cv2.addWeighted(under, 1 - mix, frame, mix, 0)

            # caption (fixed on screen)
            if cap_sprites:
                fade = cap_cfg["fadeMs"] / 1000
                for i, (cs, text) in enumerate(caps):
                    ce = caps[i + 1][0] if i + 1 < len(caps) else content_dur - fade_out
                    if not text or not (cs <= u < ce):
                        continue
                    a = min(1.0, (u - cs) / fade, (ce - u) / fade)
                    if mix < 1:
                        a *= mix
                    spr = cap_sprites[text]
                    slide = int(10 * (1 - ease(min(1.0, (u - cs) / fade))))
                    x = (W - spr.shape[1]) // 2
                    y = H - cap_cfg["bottomMargin"] - spr.shape[0] + slide
                    alpha_blend_patch(frame, x, y, spr, max(0.0, a))

            # fade out
            rem = total - t
            if rem < fade_out:
                a = ease(rem / fade_out)
                frame = cv2.addWeighted(frame, a, bg_screen, 1 - a, 0)

        if fi in still_times:
            cv2.imwrite(os.path.join(args.stills, f"still_{fi:05d}_{t:05.2f}s.png"), frame)
        ff.stdin.write(frame.tobytes())
        if fi % 90 == 0:
            print(f"  {fi}/{n_frames}", flush=True)

    ff.stdin.close()
    ff.wait()
    if ff.returncode != 0:
        sys.exit("ffmpeg failed")
    print(f"Video: {args.output} ({total:.1f} s)")

    if args.gif or o.get("gif"):
        gif = os.path.splitext(args.output)[0] + ".gif"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", args.output, "-vf",
                        "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
                        gif], check=True)
        print(f"GIF: {gif}")


if __name__ == "__main__":
    main()
