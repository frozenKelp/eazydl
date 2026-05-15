I did a code, runtime, and visual pass. Typecheck passes and `npm audit` reports 0 vulnerabilities, but the app has several real flaws.

**Highest Impact**

- `bun run build` currently fails: Bun cannot resolve Playwright’s `chromium-bidi` imports from the compile path. The documented build is broken. See [package.json](C:/Users/anu/projects/eazydl/package.json:9).
- Browse can hang on first load. A live request to `/api/scrape/search?...limit=3` timed out after 45s. The UI auto-loads Browse and has no client abort timeout. See [browse.js](C:/Users/anu/projects/eazydl/frontend/js/browse.js:429), [scraper.ts](C:/Users/anu/projects/eazydl/src/scraper.ts:72).
- “Connections per file” is fake right now. Settings save it, but downloads hardcode `const connections = 1`. See [aria2-service.ts](C:/Users/anu/projects/eazydl/src/aria2-service.ts:343).
- Settings are cached forever in the frontend. After saving settings, `loadSettings()` can re-read stale cached values. See [api.js](C:/Users/anu/projects/eazydl/frontend/js/api.js:139), [settings.js](C:/Users/anu/projects/eazydl/frontend/js/settings.js:55).
- “Reset to Defaults” does not reset download path, max concurrent files, or connections per file because `SETTINGS_DEFAULTS` omits them. See [api.js](C:/Users/anu/projects/eazydl/frontend/js/api.js:1), [settings.html](C:/Users/anu/projects/eazydl/frontend/settings.html:30).
- Resume can mark a download as `downloading` even when aria2 has no gid for it. `aria2.resume()` silently returns. See [aria2-service.ts](C:/Users/anu/projects/eazydl/src/aria2-service.ts:405), [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:494).
- Duplicate resolved filenames can overwrite each other because aria2 is started with `--auto-file-renaming=false` and `--allow-overwrite=true`. See [aria2-service.ts](C:/Users/anu/projects/eazydl/src/aria2-service.ts:126), [aria2-service.ts](C:/Users/anu/projects/eazydl/src/aria2-service.ts:602).

### Downloader / State Bugs

- Restarting the app resets `downloading`, `queued`, and `paused` to `pending`, so paused state is lost. See [database.ts](C:/Users/anu/projects/eazydl/src/db/database.ts:124).
- The DB initializes twice: once at module load and again in `startServer()`. See [database.ts](C:/Users/anu/projects/eazydl/src/db/database.ts:167), [server.ts](C:/Users/anu/projects/eazydl/src/server.ts:92).
- If an existing aria2 daemon is reused, active aria2 downloads are not re-associated with DB rows. See [aria2-service.ts](C:/Users/anu/projects/eazydl/src/aria2-service.ts:107).
- Single download stop does not check whether the row exists; nonexistent IDs still return `stopped`. See [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:535).
- Stop resets only `status`, leaving stale bytes, totals, errors, and completed timestamps. See [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:444).
- If resolving a FuckingFast link fails before enqueue, the DB is updated to failed but the websocket never tells the frontend, so the card can sit as queued until refresh. See [aria2-service.ts](C:/Users/anu/projects/eazydl/src/aria2-service.ts:552).

**Scraper / Performance**

- Every HTML fetch uses Playwright, even for simple pages. That is heavy and slow. See [scraper.ts](C:/Users/anu/projects/eazydl/src/scraper.ts:218).
- `hydrate=true` can open up to 60 browser pages concurrently through `Promise.allSettled`. See [scraper.ts](C:/Users/anu/projects/eazydl/src/scraper.ts:455).
- The frontend separately hydrates up to 4 visible cards, each requiring a backend browser page. See [browse.js](C:/Users/anu/projects/eazydl/frontend/js/browse.js:14).
- Search only inspects `Math.max(32, limit * 2)` articles before filtering, so valid results can be missed. See [scraper.ts](C:/Users/anu/projects/eazydl/src/scraper.ts:565).
- FuckingFast resolution is brittle: it only recognizes `window.open(...)` or archive-looking links. See [scraper.ts](C:/Users/anu/projects/eazydl/src/scraper.ts:274).

**Frontend / UX**

- Mobile settings actions are partly covered by the bottom nav. I confirmed the nav overlaps the Save button in a 390x844 viewport. CSS source: [style.css](C:/Users/anu/projects/eazydl/frontend/css/style.css:1411), [style.css](C:/Users/anu/projects/eazydl/frontend/css/style.css:1194).
- Library’s side panel says backend is `FastAPI`, but this is Fastify. See [library.html](C:/Users/anu/projects/eazydl/frontend/library.html:47).
- The Queue/Flow and Sources/Add Flow side panels are mostly static filler, not useful runtime UI. See [library.html](C:/Users/anu/projects/eazydl/frontend/library.html:40), [browse.html](C:/Users/anu/projects/eazydl/frontend/browse.html:39).
- Browse search input lacks an accessible label. See [browse.html](C:/Users/anu/projects/eazydl/frontend/browse.html:17).
- `browse_show_descriptions` and `browse_open_links_new_tab` exist in backend settings but have no controls and are unused by frontend code. See [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:713).
- Progress bars only move forward in-place, so reset/resume failures can leave a visually incorrect progress bar. See [library.js](C:/Users/anu/projects/eazydl/frontend/js/library.js:399).
- A failed resume request for a paused file can trigger a stop/reset fallback. That is surprising and potentially destructive. See [library.js](C:/Users/anu/projects/eazydl/frontend/js/library.js:469).
- Empty states use a huge amount of blank space and text-like “icons” such as `Library` / `Search`, which feels unfinished. See [library.js](C:/Users/anu/projects/eazydl/frontend/js/library.js:110).

**API / Validation**

- Most POST routes have no schema validation. Bad body shapes can become 500s instead of clean 400s. See [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:164), [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:267).
- Integer settings use `parseInt`, so values like `3abc` are accepted as `3`. See [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:768).
- Manual link add silently truncates to 200 URLs without telling the user. See [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:141).
- `/api/lists/:id/downloads` returns an empty list for nonexistent lists instead of 404. See [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:130).
- `/api/library` and `/api/lists` do N+1 download queries per list. Fine for tiny data, clunky later. See [api.ts](C:/Users/anu/projects/eazydl/src/api.ts:34).

**Repo / Docs**

- Runtime DB and WAL files are tracked even though `.gitignore` says to ignore DB/data. See tracked files under `data/*`, and [.gitignore](C:/Users/anu/projects/eazydl/.gitignore:10).
- Logs are tracked because `.gitignore` has `_.log`, not `*.log`. See [.gitignore](C:/Users/anu/projects/eazydl/.gitignore:21).
- README project layout is stale: it mentions `routes/`, `downloader.ts`, and `downloadService.ts` that do not exist. See [README.md](C:/Users/anu/projects/eazydl/README.md:45).
- README still says frontend was copied from Python unchanged, but the UI clearly is not unchanged. Minor, but confusing.
- There is no test script and no automated browser/UI regression check. Typecheck passing is currently the only reliable guard.
