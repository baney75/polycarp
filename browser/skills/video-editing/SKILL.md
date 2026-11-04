---
name: video-editing
description: Edit video with ffmpeg - trim, cut and join clips, captions and subtitles, b-roll and picture-in-picture, vertical crops, audio loudness, GIFs and export presets - and check each output with ffprobe and frame grabs. Use when the user asks to trim, cut, join, caption, subtitle, crop, compress or export a video, clip or screen recording, add b-roll, make a vertical short or a GIF, or normalize the audio in a recording.
license: AGPL-3.0
---

# Video editing: plan, cut with ffmpeg, then prove it

It prevents a file that "rendered fine" but has the wrong length, no audio, black frames
or captions out of sync. Every output gets measured and looked at.

## When to use

- Trimming, cutting, joining or reordering MP4 or MOV clips.
- Captions, subtitles, b-roll, a logo or picture-in-picture.
- A vertical short for TikTok or Reels cropped from a widescreen video.
- Export presets and compression for video, or an animated GIF from a few seconds of a clip.
- Quiet or uneven audio in a video or lecture recording.

For motion graphics in code (Remotion, After Effects), it covers only final checks and export.

## Steps

1. **Probe every input.**
   `ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate -of json in.mp4`
   Note duration, resolution, frame rate and whether audio exists.
2. **Plan.** A table of clips, in and out points (`HH:MM:SS.mmm`), actions and target
   format. Show it to the user for more than one cut.
3. **Work on copies.** Write each output to a new name; never overwrite an input.
4. **Cut.** Frame-accurate, re-encoded:
   `ffmpeg -ss 00:00:02 -to 00:00:06 -i in.mp4 -c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k cut.mp4`
   `-c copy` cuts fast, on keyframes only, up to a second off.
5. **Join.** Write `list.txt` with one line per clip, `file 'cut1.mp4'`, then
   `ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4`. Clips must share codec,
   size, frame rate and audio format; if any differ, normalize each and join the `n-`
   files. A clip with no audio (step 1) also gets silence: add `-f lavfi -i anullsrc=r=48000:cl=stereo -map 0:v -map 1:a -shortest`.
   `ffmpeg -i a.mp4 -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:-1:-1,setsar=1,fps=30" -c:v libx264 -crf 18 -pix_fmt yuv420p -video_track_timescale 15360 -c:a aac -b:a 192k -ar 48000 -ac 2 n-a.mp4`
6. **Caption.** Write an `.srt` file: number, `00:00:01,000 --> 00:00:03,000`, text,
   blank line. Cut an .srt timed to the source with the clip: save this as `srt_cut.py`
   and run `python3 -I srt_cut.py 12 47 < cap.srt > cap-clip.srt` (in and out seconds).
   It keeps each cue's part inside the cut, shifted to start at 0.
   ```python
   import re, sys
   A, B = (round(float(x) * 1000) for x in sys.argv[1:3])
   ms = lambda s: sum(int(x) * k for x, k in zip(re.split("[:,.]", s.strip()), (3600000, 60000, 1000, 1)))
   tc = lambda m: "%02d:%02d:%02d,%03d" % (m // 3600000, m // 60000 % 60, m // 1000 % 60, m % 1000)
   n = 0
   for blk in re.split(r"\n\s*\n", sys.stdin.read().lstrip("\ufeff").replace("\r", "").strip()):
       L = blk.split("\n"); s, e = map(ms, L[1].split("-->"))
       if e > A and s < B: n += 1; print(n, tc(max(s, A) - A) + " --> " + tc(min(e, B) - A), *L[2:], "", sep="\n")
   ```
   Untrimmed, use `cap.srt` as `cap-clip.srt`. Check `ffmpeg -hide_banner -filters`.
   - If present, burn in: `ffmpeg -i clip.mp4 -vf "subtitles=cap-clip.srt" -c:a copy subbed.mp4`
   - If not, a soft track: `ffmpeg -i clip.mp4 -i cap-clip.srt -map 0 -map 1 -c:v copy -c:a copy -c:s mov_text soft.mp4`
7. **B-roll or picture-in-picture.** Clip 2's first 3 s at 2 to 5 s, bottom right; `trim`
   picks the part, `setpts=...+2/TB` starts it at 2 s:
   `ffmpeg -i main.mp4 -i broll.mp4 -filter_complex "[1:v]trim=start=0:duration=3,setpts=PTS-STARTPTS+2/TB,scale=480:-2[pip];[0:v][pip]overlay=W-w-40:H-h-40:eof_action=pass:enable='between(t,2,5)'[v]" -map "[v]" -map 0:a? -c:v libx264 -crf 18 -c:a copy out.mp4`
   For another window, change `duration`, `+2` and `between(t,2,5)` together. Check frames
   at 2.1, 4.9 and 5.1 s. A full-frame cutaway: cut the b-roll to length, join in step 5.
8. **Vertical short**, center crop to 9:16: `ffmpeg -i in.mp4 -vf "crop=ih*9/16:ih,scale=1080:1920" -c:a copy vertical.mp4`
9. **Export with a preset** from the table below.
10. **Verify length and streams** with step 1's `ffprobe`: duration within 0.1 s of the
    plan, and audio present if the input had it.
11. **Verify loudness** for anything with speech:
    `ffmpeg -hide_banner -i out.mp4 -af ebur128 -f null -` and read `Integrated loudness`.
12. **Look at frames.** A contact sheet:
    `ffmpeg -i out.mp4 -vf "fps=1/5,scale=320:-2,tile=4x3" -frames:v 1 sheet.png`
    and single frames at each cut and caption: `ffmpeg -ss 3 -i out.mp4 -frames:v 1 f3.png`.
    Look for black frames, wrong crops and burned-in caption timing.
    Frames don't show a soft track: extract it (`ffmpeg -i out.mp4 -map 0:s:0 check.srt`)
    and compare its first cue with the plan.
13. **Hand over** path, duration, resolution, size, loudness and the sheet image.

## Export presets

| Target | Command options |
| --- | --- |
| YouTube 1080p | `-c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -af loudnorm=I=-14:TP=-1:LRA=11 -movflags +faststart` |
| Phone or web, small | `-c:v libx264 -preset medium -crf 26 -vf scale=-2:720 -c:a aac -b:a 128k -movflags +faststart` |
| Archive master | `-c:v libx264 -preset slow -crf 14 -c:a pcm_s16le` into `.mov` |
| GIF preview | `-vf "fps=12,scale=480:-2:flags=lanczos" -t 6` into `.gif` |
| Podcast audio only | `-vn -c:a libmp3lame -b:a 160k -af loudnorm=I=-16:TP=-1.5` into `.mp3` |

## Done when

- Each output's probed duration, size, frame rate and audio match the plan.
- You looked at the contact sheet and a frame at every cut and caption.
- Captions on a trimmed clip went through `srt_cut.py`; the first cue matches the plan.
- Speech is near the target loudness (about -14 LUFS for YouTube, -16 for podcasts).
- Inputs are unchanged, and the user has the output paths.

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| `No such filter: 'subtitles'` | No libass. Use step 6's soft track |
| `No option name near` on `subtitles` | No `subtitles` in `ffmpeg -hide_banner -filters`: as above (ffmpeg 9). Else copy the .srt to a plain name |
| PiP shows the wrong part or a frozen frame | Use step 7's `trim` and `setpts` |
| Concat fails or audio drifts | Inputs differ. Normalize every clip with step 5's command, then join |
| Captions late by the cut's start | The .srt was timed to the source. Cut it as in step 6 |
| Output has no audio | Add `-map 0:v -map 0:a?`; check the input had audio |

## Safety

- Work only on files the user named, and never delete source footage.
- Upload, publish or post only with the user's yes for that file; ask before publishing
  other people's faces or voices.

## Worked example

The user says: "Cut seconds 12 to 47 from talk.mp4, add these captions and make a YouTube
version."

```
ffprobe ... talk.mp4                  -> 1920x1080, 30 fps, 612 s, aac audio
ffmpeg -ss 00:00:12 -to 00:00:47 -i talk.mp4 -c:v libx264 -crf 18 -c:a aac clip.mp4
python3 -I srt_cut.py 12 47 < cap.srt > cap-clip.srt
ffmpeg -hide_banner -filters          -> no subtitles filter
ffmpeg -i clip.mp4 -i cap-clip.srt -map 0 -map 1 -c:v copy -c:a copy -c:s mov_text clip-cc.mp4
ffmpeg -i clip-cc.mp4 [YouTube preset] -c:s copy clip-yt.mp4
ffprobe ... clip-yt.mp4               -> 35.0 s, 1920x1080, audio present, subtitle track
ffmpeg -i clip-yt.mp4 -map 0:s:0 check.srt   -> first cue 00:00:01,000, as planned
ffmpeg -hide_banner -i clip-yt.mp4 -af ebur128 -f null -   -> I: -14.1 LUFS
ffmpeg -i clip-yt.mp4 -vf "fps=1/5,scale=320:-2,tile=4x2" -frames:v 1 sheet.png
```

Answer: `clip-yt.mp4`, 35.0 s, 1080p, -14.1 LUFS, soft captions, and the sheet path.
