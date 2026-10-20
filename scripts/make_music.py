#!/usr/bin/env python3
"""Generates the skill's ONE background track: assets/music/theme.m4a

This script only exists to regenerate/change the music; render.py always uses the
ready-made theme.m4a. There is deliberately a single track: every video ships with the
same music, so the product's "sound" is recognizable. Fully synthesized, no licensing issues.

The track is meant to stay in the background, not to be listened to: a softly
finger-picked nylon-string guitar (Karplus-Strong plucks) over a quiet bass, in a small
dry room. No melody, no drums, no long pads, no big reverb.

Track: Bb major (written in C, transposed down a whole tone for a warmer, lower guitar),
80 BPM, 8 bars (24 s), loops seamlessly.
  Bbmaj7 Gm7 Ebmaj7 F6 | Bbmaj7 Dm7 Ebmaj7 F7sus4

Usage: python3 scripts/make_music.py [--wav preview.wav]
"""

import argparse
import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100
BPM = 80
BEAT = 60 / BPM
BAR = 4 * BEAT
TRANSPOSE = -2  # semitones; the progression below is written in C
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(SKILL_DIR, "assets", "music", "theme.m4a")

# (chord tones MIDI, bass MIDI). Low-mid register, close voice leading.
PROG = [
    ([48, 55, 59, 64], 36),  # Cmaj7:  C G B E
    ([45, 52, 55, 60], 45),  # Am7:    A E G C
    ([41, 48, 52, 57], 41),  # Fmaj7:  F C E A
    ([43, 50, 52, 59], 43),  # G6:     G D E B
    ([48, 55, 59, 64], 36),  # Cmaj7
    ([40, 47, 50, 55], 40),  # Em7:    E B D G
    ([41, 48, 52, 57], 41),  # Fmaj7
    ([43, 50, 53, 60], 43),  # G7sus4: G D F C
]
# Finger-picking pattern: eighth notes, index into the chord tones (0 = lowest)
PATTERN = [0, 2, 1, 3, 1, 2, 1, 3]
LOOP = len(PROG) * BAR


def hz(m):
    return 440.0 * 2 ** ((m + TRANSPOSE - 69) / 12)


# ------------------------------------------------------------------ instruments
def pluck(f, dur, rng, bright=0.35):
    """A plucked string (Karplus-Strong), resampled so the pitch is exact."""
    n_out = int(dur * SR)
    N = max(2, int(round(SR / f)))
    f_ks = SR / (N + 0.5)  # the averaging filter adds half a sample of delay
    n = int(n_out * f / f_ks) + N + 2
    y = np.zeros(n)
    burst = rng.standard_normal(N)
    # a soft thumb, not a pick: smooth the noise over part of the period (bright = hiss)
    k = max(2, int(N * (0.5 - 0.4 * bright)))
    for _ in range(2):
        burst = np.convolve(burst, np.ones(k) / k, mode="same")
    y[:N] = burst - burst.mean()
    decay = 0.9965
    prev_last = 0.0
    # y[i] = decay * (y[i-N] + y[i-N-1]) / 2, computed one period at a time
    for b in range(1, n // N + 1):
        a, e = b * N, min((b + 1) * N, n)
        prev = y[a - N:a]
        blk = decay * 0.5 * (prev + np.concatenate(([prev_last], prev[:-1])))
        prev_last = prev[-1]
        y[a:e] = blk[: e - a]
    out = np.interp(np.arange(n_out) * f / f_ks, np.arange(n), y)  # pitch correction
    fade = np.clip((n_out - np.arange(n_out)) / (0.05 * SR), 0, 1)
    return out * fade / (np.max(np.abs(out)) + 1e-9)


def bass(f, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    y = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * 2 * f * t) + 0.1 * np.sin(2 * np.pi * 3 * f * t)
    return y * np.minimum(t / 0.015, 1) * np.exp(-t * 1.6)


# ------------------------------------------------------------------ mix
def add(buf, x, t0, gain, pan=0.5):
    i = int(round(t0 * SR))
    if i >= len(buf):
        return
    x = x[: len(buf) - i]
    buf[i:i + len(x), 0] += x * gain * np.sqrt(1 - pan)
    buf[i:i + len(x), 1] += x * gain * np.sqrt(pan)


def small_room(x, rng):
    """Just the feel of a small room: a short (0.4 s), dark reflection."""
    n = int(0.4 * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for c in range(2):
        ir = rng.standard_normal(n) * np.exp(-t / 0.09)
        ir = np.convolve(ir, np.ones(10) / 10, mode="same")
        ir[: int(0.008 * SR)] = 0
        ir /= np.sqrt(np.sum(ir ** 2))
        size = 1 << (len(x) + n).bit_length()
        out[:, c] = np.fft.irfft(np.fft.rfft(x[:, c], size) * np.fft.rfft(ir, size), size)[: len(x)]
    return out


def compose():
    rng = np.random.default_rng(7)  # fixed seed: every run is bit-identical
    reps = 3  # keep the middle repetition: the previous loop's tails spill into its start, so the loop is seamless
    total = int((reps * LOOP + 4) * SR)
    dry = np.zeros((total, 2))
    cache = {}

    def note(m, dur):
        if (m, dur) not in cache:
            cache[(m, dur)] = pluck(hz(m), dur, rng)
        return cache[(m, dur)]

    for r in range(reps):
        for b, (tones, root) in enumerate(PROG):
            tb = r * LOOP + b * BAR
            for i, idx in enumerate(PATTERN):
                # accent on the beat, lighter offbeats, a little human timing
                vel = (0.85 if i % 4 == 0 else 0.62 if i % 2 == 0 else 0.5) * (0.92 + 0.08 * rng.random())
                humanize = (rng.random() - 0.5) * 0.018
                add(dry, note(tones[idx], 2.2), tb + i * BEAT / 2 + humanize, 0.11 * vel, 0.42 + 0.16 * idx / 3)
            for beat in (0, 2):
                add(dry, bass(hz(root), 1.9 * BEAT), tb + beat * BEAT, 0.07)

    mix = dry + 0.22 * small_room(dry, rng)
    a = int(LOOP * SR)
    loop = mix[a:2 * a]
    # level: peak -2 dBFS; render.py sets the actual (low) playback level
    return loop / (np.max(np.abs(loop)) + 1e-9) * 0.8


def write_wav(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", help="Also write an uncompressed preview WAV")
    args = ap.parse_args()
    loop = compose()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "theme.wav")
        write_wav(wav, loop)
        if args.wav:
            write_wav(args.wav, loop)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "aac", "-b:a", "192k", OUT], check=True)
    rms = 20 * np.log10(np.sqrt(np.mean(loop ** 2)))
    print(f"{OUT}: {LOOP:.2f} s loop, RMS {rms:.1f} dBFS")


if __name__ == "__main__":
    main()
