# SwoopScores

A Chrome extension (Manifest V3) that injects **RateMyProfessor** scores directly into the University of Utah's class registration site ([class-schedule.app.utah.edu](https://class-schedule.app.utah.edu)).

When you browse the schedule, every professor name becomes a clickable link. Click one to see their RMP **overall rating**, **difficulty**, **number of ratings**, and **would-take-again percentage** — without ever leaving the page.

---

## Installation (Developer Mode)

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the **`chrome/`** subfolder inside the repo (e.g. `D:\SwoopScores\chrome`).
5. Navigate to [class-schedule.app.utah.edu](https://class-schedule.app.utah.edu) and browse any course listing.

---

## How It Works

```
class-schedule.app.utah.edu
        │
        │  DOM mutation / page load
        ▼
   content.js  ──── click ──▶  chrome.runtime.sendMessage
        │                              │
        │                              ▼
        │                       background.js  (service worker)
        │                              │
        │                              │  POST https://www.ratemyprofessors.com/graphql
        │                              │  1. NewSearchTeachersQuery  (find prof at UofU)
        │                              │  2. TeacherRatingsPageQuery (fetch stats)
        │                              │  chrome.storage.session cache
        │                              │
        │◀──────── response ───────────┘
        │
        ▼
   Popup rendered next to the professor's name
```

---

## Repository Structure

```
SwoopScores/
├── chrome/          ← Load this folder as the unpacked extension
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   └── styles.css
├── store/           ← Future Chrome Web Store assets (screenshots, icons)
├── .gitignore
├── LICENSE
├── privacy.html     ← Privacy policy stub for Web Store submission
└── README.md
```

## File Overview

| File | Purpose |
|---|---|
| `chrome/manifest.json` | Extension manifest (MV3) — declares permissions, content scripts, and service worker |
| `chrome/background.js` | Service worker — handles all RMP GraphQL API calls and session caching |
| `chrome/content.js` | Content script — scans the DOM, inserts star badges, renders the popup |
| `chrome/styles.css` | Injected styles — University of Utah crimson theme, popup card, badge states |

---

## Configuration

### Changing the school

The extension dynamically looks up the University of Utah's RMP school ID at runtime using a `NewSearchSchoolsQuery` and caches the result in `chrome.storage.local` (so the lookup only happens once per install).

To use this extension for a different university:
1. In `background.js`, change the search text and state filter inside `getSchoolId()` to match your school.
2. Clear the cached school ID by opening the extension's service worker console (`chrome://extensions` → Service Worker) and running: `chrome.storage.local.remove('swoop_school_id')`.
3. Update the `matches` URL in `manifest.json` to target your school's registration site.

### DOM selectors

If the class-schedule site updates its markup and names stop being detected, add or update selectors in the `INSTRUCTOR_SELECTORS` array at the top of `content.js`.

---

## Known Limitations

- **RMP auth key** — The `Authorization` header uses RMP's public key (`dGVzdDp0ZXN0`, i.e. `test:test`). If RMP rotates this key, the background script will log a `401` warning and requests will fail. Find the new key in `REACT_APP_GRAPHQL_AUTH` inside the RMP page source.
- **Name matching** — The extension searches RMP with the exact text found in the DOM. Hyphenated names, initials, or nicknames may not match. The first search result is used; no disambiguation UI is shown.
- **Session cache** — Results are cached in `chrome.storage.session` and cleared when the browser closes. Repeated lookups within the same session are instant.
- **MV3 service worker lifecycle** — Chrome may idle the service worker between requests. The extension handles this gracefully; there is no persistent background connection.

---

## Development & Debugging

- **Background script logs**: Open `chrome://extensions` → find SwoopScores → click **Service Worker** to open its DevTools console.
- **Content script logs**: Open DevTools on the class-schedule page (`F12`) and check the **Console** tab. All logs are prefixed with `[SwoopScores]`.
- **Reload after edits**: On `chrome://extensions`, click the refresh icon on the SwoopScores card after changing any file.

---

## License

MIT — see [LICENSE](LICENSE). Feel free to fork and adapt for your own university's registration portal.
