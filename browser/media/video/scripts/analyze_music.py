"""Beat map for the hero video's music: tempo, beats, downbeats, sections, the drop.

    ffmpeg -i public/hero/music.m4a -ac 1 -ar 22050 /tmp/hero-music.wav
    python3 scripts/analyze_music.py /tmp/hero-music.wav src/hero/music.json public/hero/music.m4a

Needs librosa (pip install librosa). Scenes read the JSON; nothing in the edit hardcodes a
time the music already knows. Also prints a check: how far each detected beat sits from
the nearest strong onset (the beat tracker's own error), in milliseconds.
"""
import json, sys
import numpy as np, librosa

path, out = sys.argv[1], sys.argv[2]
# What the JSON names as its source: the file the decoded WAV came from, if given.
source = sys.argv[3] if len(sys.argv) > 3 else path.split("/")[-1]
y, sr = librosa.load(path, sr=22050, mono=True)
dur = len(y) / sr
hop = 256
oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
tempo, beat_frames = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=hop)
beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
tempo = float(np.atleast_1d(tempo)[0])

# Energy at 10 Hz, for the entries, the drop and the end.
rms = librosa.feature.rms(y=y, hop_length=2205)[0]
t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=2205)
db = 20 * np.log10(rms + 1e-9)
def level(a, b):
    m = (t >= a) & (t < b)
    return float(db[m].mean()) if m.any() else -90.0

# Entries: beats where the full band comes back after a gap or break, i.e. the first quarter
# second after the beat is 8 dB or more louder than the 0.6 s before it. Candidates closer than
# 4 s form one entry, and the beat with the biggest rise stands for it. The first is the drop.
rise = lambda b: level(b, b + 0.25) - level(b - 0.6, b)
candidates = [float(b) for b in beats if b > 4 and rise(b) >= 8]
groups = []
for c in candidates:
    if groups and c - groups[-1][-1] <= 4:
        groups[-1].append(c)
    else:
        groups.append([c])
entries = [max(g, key=rise) for g in groups]
drop = entries[0]
drop_gain = level(drop, drop + 1.0) - level(drop - 1.0, drop)

# Downbeats: the drop starts a bar, so its beat sets the bar phase for the whole track.
drop_index = int(np.argmin(np.abs(beats - drop)))
downbeats = beats[drop_index % 4 :: 4]
bars = [(float(d), level(d, d + 60 / tempo * 4)) for d in downbeats]
body = np.median([l for d, l in bars if d >= drop])
# The end of the music: last time the level is within 20 dB of the body.
loud = t[db > body - 20]
end = float(loud[-1]) if len(loud) else dur

# Self-check: distance from each beat to the nearest onset peak.
onsets = librosa.onset.onset_detect(onset_envelope=oenv, sr=sr, hop_length=hop, units="time")
err = np.array([np.min(np.abs(onsets - b)) for b in beats]) * 1000

data = {
    "source": source,
    "duration": round(dur, 3),
    "tempo": round(tempo, 2),
    "beats": [round(float(b), 3) for b in beats],
    "downbeats": [round(float(b), 3) for b in downbeats],
    "drop": round(drop, 3),
    "dropGainDb": round(drop_gain, 1),
    "dropBeat": drop_index,
    "entries": [round(e, 3) for e in entries],
    "end": round(end, 3),
    "beatOnsetErrorMs": {"median": round(float(np.median(err)), 1), "p90": round(float(np.percentile(err, 90)), 1)},
}
with open(out, "w") as f:
    json.dump(data, f, indent=1)
print(json.dumps({k: v for k, v in data.items() if k not in ("beats", "downbeats")}))
print("first downbeats", data["downbeats"][:6], "beats", len(data["beats"]))
