# SwoopScores

Shows RateMyProfessor ratings directly on the University of Utah's class registration page. Available as a Chrome extension.

## Quick Install

**Chrome** — load unpacked from the `chrome/` folder (see instructions below)

## What It Does

When you browse courses on **class-schedule.app.utah.edu**, the extension automatically:

1. Detects instructor names adjacent to the "Instructor:" label in course rows
2. Looks them up via the **RateMyProfessor GraphQL API** (scoped to University of Utah)
3. Injects a color-coded star badge (`★ 4.2`) next to each name:
   - 🟢 Green — rating ≥ 3.5
   - 🟡 Amber — rating 2.5–3.49
   - 🔴 Crimson — rating < 2.5
4. Hover the badge to see `"RMP: X.X / 5 — click for details"`
5. Click the badge to open a popup with rating, difficulty, would-take-again %, and a link to the full RMP profile

## Installation — Chrome

1. Clone or download this repo
2. Open Chrome → `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `chrome/` folder
5. Navigate to class-schedule.app.utah.edu — badges appear automatically

## File Structure

```
SwoopScores/
├── chrome/                 ← Load this folder as the Chrome extension
│   ├── manifest.json       MV3 config, permissions, host rules
│   ├── background.js       Service worker: RMP GraphQL lookups + session cache
│   ├── content.js          Injected into class-schedule: finds instructors, injects badges
│   └── styles.css          Badge + popup styles (University of Utah crimson theme)
├── store/                  ← Future Chrome Web Store assets (screenshots, icons)
├── .gitignore
├── LICENSE
├── privacy.html            ← Privacy policy stub for Web Store submission
└── README.md
```

## Architecture

### Content script (`content.js`)

Runs on class-schedule.app.utah.edu pages. Uses a **MutationObserver** to handle the React SPA's dynamic row loading.

`scanForInstructors()` runs on every DOM change: it walks the subtree looking for elements that have a direct text node containing `"Instructor:"`, then grabs the `<a>` child links inside — those are the professor names. This avoids false-positive matches on other capitalized phrases on the page.

`cleanName()` normalizes names from the site's `Last, First` format into `First Last` before sending to RMP search.

An **eager fetch queue** fires automatically after the initial scan: all detected professors are queued and fetched with a 600ms startup delay and 200ms stagger between requests, so badges fill in without any user interaction.

### Background service worker (`background.js`)

Receives `fetchRMP` messages from the content script.

**Lookup flow (3 steps):**

1. `NewSearchSchoolsQuery` — one-time lookup of the University of Utah's RMP school ID, cached in `chrome.storage.local` (persists across browser restarts)
2. `NewSearchTeachersQuery` — search professor by name scoped to the resolved school ID
3. `TeacherRatingsPageQuery` — fetch `avgRating`, `avgDifficulty`, `numRatings`, `wouldTakeAgainPercent` for the matched teacher node

Per-professor results cached in `chrome.storage.session` (cleared when the browser closes).

### RateMyProfessors GraphQL API

Base: `https://www.ratemyprofessors.com/graphql`  
Auth: `Authorization: Basic dGVzdDp0ZXN0` (RMP's public key, base64 of `test:test`)

| Operation | Description |
|---|---|
| `NewSearchSchoolsQuery` | Search schools by name; returns `id`, `legacyId`, `name`, `city`, `state` |
| `NewSearchTeachersQuery` | Search professors at a school by name |
| `TeacherRatingsPageQuery` | Fetch `avgRating`, `avgDifficulty`, `numRatings`, `wouldTakeAgainPercent` for a teacher node |

If requests start returning `401`, find the updated key in `REACT_APP_GRAPHQL_AUTH` inside any RMP page's HTML source.

## class-schedule.app.utah.edu DOM Notes

- The site is a **React SPA** — `MutationObserver` with `subtree: true` is required to catch dynamically loaded rows
- Instructor name format: `Last, First` inside an `<a>` tag (e.g. `<a href="...">Smith, Jenn</a>`)
- The `<a>` is always a child of an element that also has a text node containing `"Instructor:"`
- Badges are inserted with `insertAdjacentElement('afterend', badge)` — placed after the `<a>`, not inside it (to keep valid HTML)
- Non-name placeholders (`TBA`, `Staff`, `TBD`, `N/A`) are excluded from badge insertion

## Adapting to DOM Changes

If badges stop appearing:

1. Open class-schedule.app.utah.edu → right-click an instructor name → **Inspect**
2. Find the element containing `Last, First` text and look at what text its parent contains
3. Update the `"Instructor:"` label regex in `scanForInstructors()` in `content.js`
4. If the instructor name is no longer in an `<a>` tag, update the `el.querySelectorAll('a')` call accordingly

## Customization

| What | Where |
|---|---|
| Badge colors | `styles.css` — `.swoop-badge-good`, `.swoop-badge-ok`, `.swoop-badge-bad` |
| Popup appearance | `styles.css` — `.swoop-popup`, `.swoop-header`, `.swoop-stats` |
| School ID | `background.js` — `getSchoolId()` search text and state filter |
| Fetch stagger between professors | `content.js` — `drainFetchQueue()` setTimeout value (default `200ms`) |
| Initial scan delay | `content.js` — `queueEagerFetch()` initial setTimeout (default `600ms`) |

## Development & Debugging

- **Background script logs**: `chrome://extensions` → SwoopScores → click **Service Worker** to open its DevTools console
- **Content script logs**: Open DevTools on the class-schedule page (`F12`) → **Console** tab. All logs are prefixed with `[SwoopScores]`
- **Reload after edits**: On `chrome://extensions`, click the refresh icon on the SwoopScores card

## Privacy

- Only communicates with `ratemyprofessors.com`
- Professor names read from the page are used only for the RMP search query and are never stored or transmitted elsewhere
- Results cached locally via `chrome.storage.session` (cleared on browser close) and `chrome.storage.local` (school ID only)
- No analytics or tracking
- Only runs on `class-schedule.app.utah.edu` pages

Full privacy policy: https://everettrike-source.github.io/SwoopScores/privacy.html

## Disclaimer

Not affiliated with the University of Utah or RateMyProfessors.

## License

MIT — see [LICENSE](LICENSE). Feel free to fork and adapt for your own university's registration portal.
