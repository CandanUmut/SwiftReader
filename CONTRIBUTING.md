# Contributing to SwiftReader

Thanks for your interest in improving SwiftReader! This project is a vanilla JS, local-first web app, so we keep contributions lightweight and privacy-respecting.

## Getting set up locally

1. Fork the repo and clone your fork.
2. Run a local server (recommended):

```bash
python -m http.server 8080
# or
npx serve
```

3. Open `http://localhost:8080` in your browser.

> You can open `index.html` directly, but a local server makes file access and PDF/EPUB loading more reliable.

## Project structure

- `index.html` — main app UI
- `styles.css` — global styles
- `app.js` — main app logic
- `vendor/` — third-party libraries
- `docs/` — documentation

## Branching and PR workflow

- Create a branch from `main` for your change.
- Keep PRs small and focused.
- Open a pull request and describe **what** and **why**.

### PR checklist (Definition of Done)

- [ ] No console errors in the browser
- [ ] Tested on **desktop** and **mobile** (or responsive mode)
- [ ] Import/export still works
- [ ] Existing IDs are not renamed
- [ ] Docs updated if behavior changes

## Issue reporting guidance

When filing a bug report, please include:

- Steps to reproduce
- Expected vs actual behavior
- Browser + OS + device
- Sample file (if possible) or file type + size
- Console errors (screenshot preferred)
- Whether it happens on mobile, desktop, or both

See the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).

## Style conventions

- Vanilla JS/HTML/CSS only (no framework introductions).
- Keep IDs and data attributes stable (avoids breaking UI bindings).
- Prefer minimal diffs; avoid large rewrites unless necessary.
- Keep changes privacy-first: no tracking, no accounts.

## Adding features safely

If you’re adding a feature:

1. Add a small, focused change.
2. Smoke test basic flows:
   - Import a TXT and a PDF
   - Open RSVP reader and play/pause
   - Add a note and verify it appears in Notes
   - Export and re-import data
3. Update docs if behavior changes.

## Testing and debugging

SwiftReader has no formal test suite yet. Please use the smoke checklist above and watch the browser console for errors.

## Security issues

Please **do not** open public issues for security reports. See [SECURITY.md](SECURITY.md) for responsible disclosure.
