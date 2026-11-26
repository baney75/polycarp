# The browser in the OS

A browser that runs the Polycarp extension tells Polycarp what it has open, so the launcher, the switcher and the bar can
show it. Any Chromium browser works; macOS ships first. The matcher lives in `Sources/BrowserMatch/`, pinned by
`BrowserTableTests.swift`; what the extension may send is checked in `Sources/BaneySpacesCore/Browser/`, pinned by
`BrowserMessageTests.swift`, and what Polycarp holds of it, by `BrowserBookTests.swift`.

- **R-B1 Ranking.** A row is a title and an address, folded (lowercased, accents dropped), the address without its
  scheme and `www.` and matched for its first 300 bytes. Scores are on the scale the Mac launcher gives an app's name
  (`Fuzzy`): the whole title 1000, its start 900, the site's start 880, a word's start 700 in the title and 650 in the
  address, inside 500 and 450, less a point for each character of the title, up to 99. Up to four words typed apart must
  all be there, and rank as the weakest of them, at most 600; found together as typed, they rank as one word does. A
  row's use adds up to 60. Ties go to the row added last.
- **R-B2 Speed.** With 2,000 tabs and 50,000 visited pages a key press's search stays under 16 ms at p90
  (`BrowserTableTests` and `BrowserSpeedTests`, built optimized as it ships, for the slowest of the searches it tries).
- **R-B3 Private windows.** Nothing from a private window enters the record. A tab, tab group or download counts only when the
  extension says outright that it isn't private; one that doesn't say is left out.
- **R-B4 Switches.** Tabs, tab groups, bookmarks, history and downloads each have a switch. Off, Polycarp takes nothing of that kind,
  drops what it held and answers nothing from it. What came while it was off isn't there when it goes back on.
- **R-B5 Memory only.** The record is in the app's memory: never on disk, never in a log, a trace or a crash's text,
  never sent to another machine. It goes when the browser goes, the switch goes off or Polycarp quits. A row can't be
  encoded, printing one says only its kind, and an id says nothing of the page. A name and
  password in an address are dropped as it is read.
- **R-B6 One place, one row.** An address that is open in a tab is offered as that tab and not again as a bookmark, a
  visited page or a download; a bookmark goes before a visited page. Two tabs of one page are two rows. A tab's id is the
  session engine's id for it, so a tab both know is one row.
- **R-B7 Limits.** At most 5,000 tabs, 500 tab groups, 20,000 bookmarks, 50,000 visited pages and 500 downloads are kept from one browser
  profile. A tab's use is 25, a tab group's 30 and a bookmark's 10; a visited page's is its visits, up to 30, and 20 for today, 12 for this
  week or 5 for this month.
- **R-B8 Site icons.** A site's icon is the browser's own copy, asked for the first time a row shows it, once a site: a PNG of
  at most 64 KB. One nobody asked for is dropped. The newest 400 sites' are held, in memory, until the last browser goes or a
  switch changes.
- **R-B9 Which window is which.** A browser's window is the Mac's window the session engine read for its tabs, else the one
  whose title is its front tab's, alone or before " - " and what the browser adds. A title two windows or two front tabs share
  names neither; of two that fit, the longer title does.
- **R-B10 Here.** A tab Polycarp opens ("New Tab Here", a search, a bookmark, a visited page, a link the launcher or Polycarp's
  terminal opens) goes to the browser's window on the workspace the person is on, the one last used there first. With none
  there it gets a window of its own there. Windows that are all here but not told apart leave the choice to the browser. With
  two profiles and no known window here, or without the extension, the address opens as macOS opens it.
- **R-B11 Cmd-Tab.** A browser's window in the switcher is named by its front tab's title and shows its site's icon on the
  browser's, where the window is known; every other window is named as it was.
- **R-B12 Tab groups.** A group's name and a workspace's number sends the whole group there: into the browser's window on that
  workspace when one is known, else into a window of its own, which is taken there as it opens. The group belongs to the
  workspace its window is on and Polycarp keeps no other record of it.
- **R-B13 The bar.** The `page` module, in no default, shows a workspace's front page: the tab in front of the browser window last
  used there, or of the only one known there. The sound mark is the front page's when it plays, else the first tab's that does.
  Downloads are one percentage when every size is known, else their count. Clicking a part goes to that tab or shows the
  download. It shows nothing of a source that is off.
- **R-B14 Notifications.** While the bar's `notifications` list is kept, a download that was not done before and ended in the last
  minute is an entry in it: the file's name, the site and its icon; clicking it shows the file in Finder. Switching downloads
  off drops those entries. A web notification is the browser's own banner, so only sites the person allowed have one: the site
  its subtitle names (an ASCII host) gives the entry its icon. Clicking it presses the banner while it is up, as a click on it
  does; after that it goes to a tab open on that site, else to the browser.
- **R-B15 Web apps.** "Make This an App" keeps a page's name, address, browser and icon in `webapps.json`, because the person
  made it; removing the app removes them, and Polycarp keeps nothing else of the browser's. An app is one page in one browser.
  It opens in a window with no tab strip, and one that is open is gone to instead. The extension says which window is which
  app's until the browser quits. A window with no tab strip never takes a new tab.
