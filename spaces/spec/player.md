# Player

Polycarp's built-in player for songs, videos and photos. It follows the rest of Polycarp: one thing in front,
nothing noisy, and fast enough that opening a file feels like it was already open. macOS ships first; Windows follows
these rules (see "Windows" below). The pure rules live in `Sources/BaneySpacesCore/Player/` and are pinned by
`PlayerTests.swift`.

## Rules

- **R-P1 Files.** Songs: mp3, m4a, flac, wav, aac. Videos: mp4, mov, m4v, mkv. Photos: jpg, jpeg, png, heic, heif, gif,
  webp and camera raw (dng, cr2, cr3, nef, nrw, arw, srf, sr2, raf, orf, rw2, pef, srw, 3fr, erf, iiq, rwl, raw). The
  kind comes from the extension alone, case ignored, so the check reads no disk. A file the system can't play (most
  mkv files on macOS, whose AVFoundation opens only some) shows one plain line saying so, never a black window.
- **R-P2 Folder playlist.** The playlist is every file of R-P1 in the opened file's folder, hidden files (a leading dot)
  left out, in Finder's name order: digit runs compare by value ("2" before "10", "0009" before "10"), letters ignore
  case, and an exact tie falls back to the plain names so every machine sorts alike. The opened file is always in it.
  The ends don't wrap. A song that ends goes on to the next song, passing photos and videos; a video stops on its last
  frame.
- **R-P3 Keys.** For songs and videos: Space plays or pauses; Left and Right seek 5 s (Shift: 30 s); Up and Down change
  the volume by 10%. For photos: Left and Right go to the previous or next file. For all: F fills the screen or comes
  back, Esc closes, Command-I shows the file's details, Command-W closes, Command-Left and Command-Right go to the
  previous or next file. Any Control or Option chord, and every other key, passes on to the system. A held key repeats a
  seek, a step or the volume, never a toggle. Double-click fills the screen.
- **R-P4 Speed.** On a warm app a file shows in under 50 ms: one window, made once and reused; nothing on the main
  thread reads the disk or decodes. A photo is decoded no larger than the screen needs and fully, into the app's own
  bitmap, off the main thread; the two photos beside it in the playlist are decoded before they are asked for. The
  decode of a 4000 x 3000 JPEG for a 3024 x 1964 screen has a 45 ms budget (best of nine), pinned by
  `PhotoDecodeSpeedTests`.
- **R-P5 Picking up again.** A video longer than 10 minutes remembers where you were, per file, and starts there next
  time. A place within 10 s of the start isn't kept, one within 30 s of the end counts as watched and is forgotten, a file
  whose length changed by more than 1 s is a different file, and the store keeps the 200 most recent.
- **R-P6 Now Playing.** While a song or video is loaded the system's media controls (media keys, Control Center,
  headphone buttons) play, pause, skip and scrub it, and show its title, artist, album and cover. Closing the player or
  showing a photo hands them back.
- **R-P7 Calm chrome.** The stage is the theme's `dark` role in every palette. A bar at the bottom (name, place in the
  folder, and for songs and videos the time and a scrubber in the accent) and the window's buttons fade out after
  1.5 s with no pointer movement or key, and stay while the pointer is on the bar. Filling the screen fills it in place,
  with no move to another desktop, and hides the cursor once the bar goes.
- **R-P8 Entry points.** `polycarp-spaces play <file>` (local only; another machine's token never gets it), the app as
  an Alternate handler for the types of R-P1 (it shows in Open With and never takes a default), and one function the
  launcher can call (`Player.open(_:)`).

## macOS

`Sources/BaneySpaces/Player.swift`: AppKit, AVKit's `AVPlayerView` for video with its own controls off, one `AVPlayer`
for songs and videos, ImageIO and a `CALayer` for photos, `CGAnimateImageAtURLWithBlock` for animated GIFs,
`MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` for R-P6. Resume places are kept in
`~/Library/Application Support/BaneySpaces/player-resume.json`. `trace.log` gets one line per open:
`player: photo first frame N ms (cached|decoded, WxH)`, `player: video first frame N ms`, `player: audio ready N ms`.

Why the photo decode is not `CGImageSourceCreateThumbnailAtIndex` at screen size: measured on this Mac, that call
resamples on the CPU at any size that isn't a power-of-two fraction of the photo, and took 195 to 590 ms at best for a
12-megapixel JPEG. A plain decode with `kCGImageSourceSubsampleFactor` (1, 2, 4 or 8, the largest that still covers the
screen) drawn into an RGBX bitmap took about 30 ms, and the GPU scales the rest. `ShouldCacheImmediately` alone left
the decode for first use, which would have been Core Animation's commit on the main thread. Camera raw keeps the
thumbnail call, which renders the raw data at the size asked for.

## Windows (not built yet)

The rules above are the contract; the Windows build reuses them as written.

- **Pure rules.** `PlayerMedia`, `PlayerPlaylist` (with `NameOrder`), `PlayerKeys` and `PlayerResume` use Foundation
  only. Port them to the Rust core (`crates/`) next to the launcher's matcher so both platforms share one tested copy,
  or run the Swift tests' cases as conformance cases against the port.
- **Video and songs.** WinUI 3 `MediaPlayerElement` with `AreTransportControlsEnabled = false` (Polycarp draws its own
  bar), backed by one reused `Windows.Media.Playback.MediaPlayer` (Media Foundation underneath). Media Foundation
  plays mp4, mov (H.264/HEVC), m4v, mp3, m4a/aac, wav and flac; mkv plays with the system's MKV support on current
  Windows 11 builds, and a file it refuses gets R-P1's line.
- **Photos.** Windows Imaging Component (`IWICBitmapDecoder`, with `IWICBitmapSourceTransform` to decode at a scale
  for JPEG, the same trick as the subsample factor) into a Direct2D or Composition surface, off the UI thread; WebP,
  HEIF and camera raw through the Store codec extensions (WebP and HEIF Image Extensions, Raw Image Extension) and say
  so when one is missing. GIF frames from WIC's frame decoder.
- **Now Playing.** `SystemMediaTransportControls` (from `MediaPlayer.SystemMediaTransportControls`, or the
  `ISystemMediaTransportControlsInterop` for a Win32 window) for media keys and the volume flyout.
- **Fill.** A borderless window sized to the monitor's rect in place, not the OS's full-screen mode.
- **Entry points.** `polycarp play <file>` over the same local pipe as the other commands; the app registered under
  `HKCU\Software\Classes\<ext>\OpenWithProgids` (Open With only, never the default association); the launcher calls
  the same open function.
- **Resume store.** `%LOCALAPPDATA%\Polycarp\player-resume.json`, the same JSON as on the Mac.
