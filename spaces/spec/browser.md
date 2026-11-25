# The browser in the OS

A browser that runs the Polycarp extension tells Polycarp what it has open, so the launcher, the switcher and the bar can
show it. Any Chromium browser works; macOS ships first. The matcher lives in `Sources/BrowserMatch/`, pinned by
`BrowserTableTests.swift`; what the extension may send is checked in `Sources/BaneySpacesCore/Browser/`, pinned by
`BrowserMessageTests.swift`.

- **R-B1 Ranking.** A row is a title and an address, folded (lowercased, accents dropped), the address without its
  scheme and `www.` and matched for its first 300 bytes. Scores are on the scale the Mac launcher gives an app's name
  (`Fuzzy`): the whole title 1000, its start 900, the site's start 880, a word's start 700 in the title and 650 in the
  address, inside 500 and 450, less a point for each character of the title, up to 99. Up to four words typed apart must
  all be there, and rank as the weakest of them, at most 600; found together as typed, they rank as one word does. A
  row's use adds up to 60. Ties go to the row added last.
- **R-B2 Speed.** With 2,000 tabs and 50,000 visited pages a key press's search stays under 16 ms at p90
  (`BrowserTableTests`, built optimized as it ships, for the slowest of the searches it tries).
- **R-B3 Private windows.** Nothing from a private window enters the record. A tab or download counts only when the
  extension says outright that it isn't private; one that doesn't say is left out.
