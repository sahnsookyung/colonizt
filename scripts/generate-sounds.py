"""Rebuild Colonizt's original, hand-shaped action cues with Python's standard library.

The palette uses muted wood, paper, and clay-like resonances. All randomness is
seeded so the checked-in WAVs can be reproduced without external samples.
"""

from __future__ import annotations

import math
import random
import struct
import wave
from pathlib import Path


SAMPLE_RATE = 44_100
OUTPUT = Path(__file__).resolve().parents[1] / "packages/web/public/sounds"
TAU = 2 * math.pi


def canvas(seconds: float) -> list[float]:
    return [0.0] * round(seconds * SAMPLE_RATE)


def note(
    samples: list[float],
    start: float,
    pitch: float,
    level: float,
    decay: float,
    *,
    attack: float = 0.009,
    harmonics: tuple[float, ...] = (1.0, 0.22, 0.065),
) -> None:
    """A softly struck bar: a rounded onset and fast-fading upper partials."""
    first = round(start * SAMPLE_RATE)
    length = min(len(samples) - first, round(decay * 6 * SAMPLE_RATE))
    for offset in range(max(0, length)):
        t = offset / SAMPLE_RATE
        envelope = (1 - math.exp(-t / attack)) * math.exp(-t / decay)
        tone = sum(
            partial * math.sin(TAU * pitch * (index + 1 + 0.004 * index) * t)
            * math.exp(-index * t / (decay * 0.48))
            for index, partial in enumerate(harmonics)
        )
        samples[first + offset] += level * envelope * tone


def texture(
    samples: list[float],
    start: float,
    duration: float,
    level: float,
    *,
    seed: int,
    cutoff: float = 850,
    attack: float = 0.007,
) -> None:
    """Low-passed noise gives taps and shuffles a tactile paper/wood surface."""
    rng = random.Random(seed)
    first = round(start * SAMPLE_RATE)
    length = min(len(samples) - first, round(duration * SAMPLE_RATE))
    alpha = 1 - math.exp(-TAU * cutoff / SAMPLE_RATE)
    previous = 0.0
    for offset in range(max(0, length)):
        t = offset / SAMPLE_RATE
        previous += alpha * (rng.uniform(-1, 1) - previous)
        envelope = (1 - math.exp(-t / attack)) * math.exp(-4 * t / duration)
        samples[first + offset] += level * previous * envelope


def wood(samples: list[float], start: float, level: float, pitch: float, seed: int) -> None:
    note(samples, start, pitch, level, 0.07, attack=0.003,
         harmonics=(1.0, 0.32, 0.09))
    texture(samples, start, 0.075, level * 0.43, seed=seed, cutoff=1050,
            attack=0.002)


def room(samples: list[float]) -> None:
    """Two quiet reflections soften the cut without introducing a long tail."""
    dry = samples.copy()
    for delay, gain in ((0.037, 0.115), (0.073, 0.052)):
        shift = round(delay * SAMPLE_RATE)
        for index in range(shift, len(samples)):
            samples[index] += gain * dry[index - shift]


def write(name: str, samples: list[float]) -> None:
    room(samples)
    fade = min(len(samples), round(0.035 * SAMPLE_RATE))
    for index in range(fade):
        samples[-fade + index] *= (fade - index - 1) / fade
    peak = max(abs(sample) for sample in samples)
    if peak > 0.68:
        samples = [sample * 0.68 / peak for sample in samples]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUTPUT / name), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        target.writeframes(b"".join(struct.pack("<h", round(max(-1, min(1, sample)) * 32767))
                                    for sample in samples))


def make_cues() -> None:
    select = canvas(0.15)
    wood(select, 0.006, 0.30, 330, 11)
    write("ui-select.wav", select)

    dice = canvas(0.48)
    for index, (start, level) in enumerate(((0.012, 0.29), (0.092, 0.25),
                                            (0.162, 0.21), (0.226, 0.18),
                                            (0.282, 0.13))):
        wood(dice, start, level, 165 + 19 * (index % 3), 30 + index)
    texture(dice, 0.02, 0.33, 0.16, seed=40, cutoff=600, attack=0.013)
    write("dice-roll.wav", dice)

    road = canvas(0.32)
    wood(road, 0.008, 0.37, 196, 51)
    wood(road, 0.093, 0.24, 246.94, 52)
    write("build-road.wav", road)

    settlement = canvas(0.48)
    wood(settlement, 0.011, 0.33, 220, 61)
    note(settlement, 0.099, 293.66, 0.27, 0.16)
    note(settlement, 0.117, 440, 0.11, 0.11)
    write("build-settlement.wav", settlement)

    city = canvas(0.69)
    wood(city, 0.012, 0.34, 196, 71)
    note(city, 0.087, 293.66, 0.21, 0.25)
    note(city, 0.142, 392, 0.17, 0.24)
    note(city, 0.196, 493.88, 0.11, 0.20)
    write("upgrade-city.wav", city)

    trade = canvas(0.43)
    wood(trade, 0.018, 0.28, 261.63, 81)
    wood(trade, 0.154, 0.23, 329.63, 82)
    texture(trade, 0.12, 0.19, 0.085, seed=83, cutoff=670)
    write("trade.wav", trade)

    card = canvas(0.53)
    texture(card, 0.011, 0.25, 0.32, seed=91, cutoff=1150,
            attack=0.028)
    note(card, 0.106, 349.23, 0.22, 0.21)
    note(card, 0.145, 440, 0.10, 0.18)
    write("dev-card.wav", card)

    thief = canvas(0.50)
    note(thief, 0.012, 146.83, 0.27, 0.19, attack=0.018,
         harmonics=(1.0, 0.10))
    note(thief, 0.092, 174.61, 0.18, 0.15, attack=0.022,
         harmonics=(1.0, 0.08))
    texture(thief, 0.027, 0.22, 0.13, seed=101, cutoff=360,
            attack=0.026)
    write("thief.wav", thief)

    discard = canvas(0.36)
    texture(discard, 0.012, 0.23, 0.46, seed=111, cutoff=950,
            attack=0.024)
    wood(discard, 0.142, 0.21, 185, 112)
    write("discard.wav", discard)

    handoff = canvas(0.42)
    note(handoff, 0.012, 392, 0.20, 0.13)
    note(handoff, 0.131, 293.66, 0.23, 0.16)
    write("turn-handoff.wav", handoff)

    finish = canvas(1.24)
    wood(finish, 0.018, 0.21, 196, 121)
    for pitch, level, delay in ((196, 0.18, 0.07), (293.66, 0.17, 0.13),
                                (392, 0.16, 0.20), (493.88, 0.095, 0.27)):
        note(finish, delay, pitch, level, 0.39, attack=0.023,
             harmonics=(1.0, 0.14, 0.025))
    write("game-over.wav", finish)


if __name__ == "__main__":
    make_cues()
