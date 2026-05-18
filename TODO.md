# TODO

High-value next moves, roughly in the order they should happen.

## Downloads

- [ ] Add magnet link support.
- [ ] Add `.torrent` link support.
- [ ] Let users choose which file groups to add before creating hundreds of rows.
- [ ] Detect optional language packs, bonus content, and credits packs.
- [ ] Add per-game default selections: base game only, base plus English, everything.
- [ ] Improve FuckingFast direct-link resolving and error messages.
- [ ] Add link recheck/refresh for stale links.
- [ ] Add a link verification pass that checks link health and records remote file sizes before download.
- [ ] Add queue reordering and per-game "move to top" controls.
- [ ] Add a clear "single file at a time is recommended" control beside simultaneous downloads.

## Index

- [ ] Show index update progress in the UI.
- [ ] Add last-updated and last-run details to the index status panel.
- [ ] ~~Add a saved-page import screen.~~
- [ ] Add a safer full rebuild flow with confirmation and progress.
- [ ] Add index repair: verify `index.json` paths and missing game files.
- [ ] Index screenshots/media from game pages for richer detail pages.
- [ ] Index FitGirl sidebar/landing sections: Latest Repacks, Top 150 of the Year, Most Popular of the Month.
- [ ] Index Updates Digest as per-game update notes.

## Browse

- [ ] Add filters for genre/tag/category, year, size range, and update date.
- [ ] Add sorting: newest, title, smallest repack, largest original size.
- [ ] Add keyboard navigation for search results.
- [ ] Add better cover-image fallback and local image cache.
- [ ] Add duplicate/installed/library badges on browse cards.
- [ ] Replace temporary latest/recent shelves with real indexed FitGirl sections.

## Library

- [ ] Add library search and filters.
- [ ] Add game detail pages inside the library.
- [ ] Add notes/tags owned by the user.
- [ ] Add install-state tracking: queued, downloaded, extracted, installed.
- [ ] Add bulk remove and bulk start by game.

## UI

- [ ] Refine the current web UI: spacing, density, mobile layout, dialogs.
- [ ] Add a clearer first-run setup screen.
- [ ] Add proper loading states instead of plain text changes.
- [ ] Add inline error panels for failed index/download actions.
- [ ] Add a compact mode for large libraries.

## App

- [ ] Add tests for API routes and index store reads.
- [ ] Add downloader tests with mocked aria2 RPC.
- [ ] Add a single command for local smoke checks.
- [ ] Add Windows-friendly process cleanup for dev server tests.
- [ ] Consider a future TUI after the web UI is stable.
