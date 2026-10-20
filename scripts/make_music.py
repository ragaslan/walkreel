#!/usr/bin/env python3
"""Generates the skill's ONE background track: assets/music/theme.m4a

This script only exists to regenerate/change the music; render.py always uses the
ready-made theme.m4a. There is deliberately a single track: every video ships with the
same music, so the product's "sound" is recognizable. Fully synthesized, no licensing issues.

Track: 92 BPM, F major, 16 bars (~41.7 s), loops seamlessly.
  A (bars 1-8):  Fmaj7 Am7 Bbmaj7 Cadd9 x2   pad + Rhodes arpeggio + bass + soft drums
  B (bars 9-16): Dm7 Bbmaj7 Fmaj7 C, Dm7 Bbmaj7 Gm7 C   + bell melody (F major pentatonic)

Usage: python3 scripts/make_music.py [--wav preview.wav]
"""

import argparse
import os
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100
BPM = 92
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 16
LOOP = BARS * BAR
SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(SKILL_DIR, "assets", "music", "theme.m4a")


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


# ------------------------------------------------------------------ harmony
# Chords: (pad voicing MIDI, bass root MIDI). Voice leading kept close.
CH = {
    "Fmaj7": ([53, 57, 60, 64], 41),
    "Am7": ([55, 57, 60, 64], 45),
    "Bbmaj7": ([50, 53, 57, 62], 46),
    "Cadd9": ([55, 60, 62, 64], 48),
    "Dm7": ([53, 57, 60, 62], 38),
    "Gm7": ([53, 55, 58, 62], 43),
    "C": ([55, 60, 64, 67], 48),
}
PROG = ["Fmaj7", "Am7", "Bbmaj7", "Cadd9"] * 2 + ["Dm7", "Bbmaj7", "Fmaj7", "C", "Dm7", "Bbmaj7", "Gm7", "C"]

# Arpeggio: chord tones an octave up, eighth notes; different patterns in A and B.
ARP_A = [0, 2, 1, 3, 2, 1, 3, 2]
ARP_B = [0, 1, 2, 3, 1, 2, 3, 1]

# Section B melody: (bar, beat, MIDI, length in beats). F major pentatonic (F G A C D).
MELODY = [
    (8, 0, 69, 1), (8, 1, 72, 1), (8, 2, 74, 2),
    (9, 0, 72, 1), (9, 1, 69, 1), (9, 2, 65, 2),
    (10, 0, 67, 1), (10, 1, 69, 1), (10, 2, 72, 2),
    (11, 0, 67, 3),
    (12, 0, 69, 1), (12, 1, 72, 1), (12, 2, 74, 1), (12, 3, 77, 1),
    (13, 0, 74, 1), (13, 1, 72, 1), (13, 2, 69, 2),
    (14, 0, 67, 1), (14, 1, 69, 1), (14, 2, 72, 2),
    (15, 0, 72, 3),
]


# ------------------------------------------------------------------ instruments
def env_adsr(n, a, d, s, r, hold):
    """hold: the sample where the release starts. a, d, r are in seconds."""
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    th = hold / SR
    rel = np.where(t > th, np.exp(-(t - th) / max(r, 1e-4)), 1.0)
    return e * rel


def pad(m, dur, detune_cents):
    n = int((dur + 1.6) * SR)
    t = np.arange(n) / SR
    f = hz(m) * 2 ** (detune_cents / 1200)
    y = np.zeros(n)
    # softened saw: harmonics at 1/k with exponential roll-off (warm, not bright)
    for k in range(1, 9):
        y += np.sin(2 * np.pi * f * k * t + k * 0.7) / k * np.exp(-k / 3.6)
    return y * env_adsr(n, 0.45, 1.2, 0.8, 0.9, int(dur * SR))


def rhodes(m, vel):
    n = int(1.6 * SR)
    t = np.arange(n) / SR
    f = hz(m)
    index = 2.2 * np.exp(-t * 5.0)
    y = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * t))
    y += 0.2 * np.sin(2 * np.pi * f * 14 * t) * np.exp(-t * 35)  # tine attack
    amp = np.minimum(t / 0.004, 1) * np.exp(-t * 2.6)
    return y * amp * vel


def bell(m, dur):
    n = int((dur + 2.0) * SR)
    t = np.arange(n) / SR
    f = hz(m)
    index = 0.9 * np.exp(-t * 3.0)
    y = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * 2 * t))
    y += 0.18 * np.sin(2 * np.pi * f * 3.01 * t) * np.exp(-t * 4)
    amp = np.minimum(t / 0.006, 1) * np.exp(-t * 1.4)
    return y * amp


def bass(m, dur):
    n = int((dur + 0.25) * SR)
    t = np.arange(n) / SR
    f = hz(m)
    # 2nd and 3rd harmonics: audible on laptop speakers too
    y = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) + 0.12 * np.sin(2 * np.pi * 3 * f * t)
    return y * env_adsr(n, 0.012, 0.35, 0.7, 0.08, int(dur * SR))


def kick():
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    freq = 45 + 75 * np.exp(-t * 28)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    return np.sin(phase) * np.exp(-t * 11)


def hat(rng, vel):
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    x = np.diff(np.diff(rng.standard_normal(n + 2)))  # crude high-pass
    return x / 4 * np.exp(-t * 70) * vel


def snare(rng):
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    lp = np.convolve(x, np.ones(6) / 6, mode="same")
    noise = (x - np.convolve(x, np.ones(40) / 40, mode="same")) * 0.5 + lp * 0.5
    body = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30)
    return (noise * np.exp(-t * 22) * 0.6 + body * 0.5)


# ------------------------------------------------------------------ mix
def add(buf, x, t0, gain, pan=0.5):
    i = int(round(t0 * SR))
    if i >= len(buf):
        return
    x = x[: len(buf) - i]
    buf[i:i + len(x), 0] += x * gain * np.sqrt(1 - pan)
    buf[i:i + len(x), 1] += x * gain * np.sqrt(pan)


def reverb_ir(rng, seconds=2.2, decay=0.55):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = np.zeros((n, 2))
    for c in range(2):
        x = rng.standard_normal(n) * np.exp(-t / decay)
        x = np.convolve(x, np.ones(8) / 8, mode="same")  # darken the tail
        x[: int(0.012 * SR)] = 0  # pre-delay
        ir[:, c] = x / np.sqrt(np.sum(x ** 2))
    return ir


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    size = 1 << (n - 1).bit_length()
    out = np.zeros((len(x), 2))
    for c in range(2):
        y = np.fft.irfft(np.fft.rfft(x[:, c], size) * np.fft.rfft(ir[:, c], size), size)
        out[:, c] = y[: len(x)]
    return out


def compose():
    rng = np.random.default_rng(1729)  # fixed seed: every run is bit-identical
    reps = 3  # keep the middle repetition: the previous loop's tails spill into its start, so the loop is seamless
    total = int((reps * LOOP + 3) * SR)
    dry = np.zeros((total, 2))
    wet = np.zeros((total, 2))

    for r in range(reps):
        base = r * LOOP
        for bar, name in enumerate(PROG):
            voicing, root = CH[name]
            tb = base + bar * BAR
            section_b = bar >= 8
            # pad: opposite detune per channel for a wide stereo image
            for m in voicing:
                for det, pan in ((-7, 0.2), (7, 0.8)):
                    x = pad(m, BAR, det)
                    add(dry, x, tb, 0.030, pan)
                    add(wet, x, tb, 0.030, pan)
            # arpeggio
            tones = [v + 12 for v in voicing]
            pattern = ARP_B if section_b else ARP_A
            for i, idx in enumerate(pattern):
                vel = (0.95 if i % 2 == 0 else 0.7) * (0.9 + 0.1 * rng.random())
                swing = 0.03 * BEAT if i % 2 else 0.0
                x = rhodes(tones[idx], vel)
                pan = 0.35 if i % 2 == 0 else 0.65
                add(dry, x, tb + i * BEAT / 2 + swing, 0.095, pan)
                add(wet, x, tb + i * BEAT / 2 + swing, 0.05, pan)
            # bass: beat 1 (1.5 beats), 2.5 (half), 3 (2 beats)
            for beat, length in ((0, 1.4), (1.5, 0.45), (2, 1.9)):
                add(dry, bass(root, length * BEAT), tb + beat * BEAT, 0.085)
            # drums
            for beat in (0, 2):
                add(dry, kick(), tb + beat * BEAT, 0.12)
            if bar % 4 == 3:
                add(dry, kick(), tb + 3.5 * BEAT, 0.07)
            for beat in (1, 3):
                s = snare(rng)
                add(dry, s, tb + beat * BEAT, 0.08, 0.55)
                add(wet, s, tb + beat * BEAT, 0.05, 0.55)
            for i in range(8):
                vel = 1.0 if i % 2 else 0.55
                add(dry, hat(rng, vel), tb + i * BEAT / 2 + (0.03 * BEAT if i % 2 else 0), 0.16, 0.62)
        # melody
        for bar, beat, m, length in MELODY:
            x = bell(m, length * BEAT)
            t0 = base + bar * BAR + beat * BEAT
            add(dry, x, t0, 0.10, 0.55)
            add(wet, x, t0, 0.08, 0.55)

    mix = dry + 0.55 * convolve(wet, reverb_ir(rng))
    a = int(LOOP * SR)
    loop = mix[a: 2 * a]
    # level: peak -1 dBFS, soft saturation
    loop = np.tanh(loop / np.max(np.abs(loop)) * 1.2) / np.tanh(1.2) * 0.89
    return loop


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
