# Development Guide

This guide covers local development, testing, and debugging for SwiftReader.

## Local server options

A local server is recommended for PDF/EPUB handling.

```bash
# Python
python -m http.server 8080

# Node
npx serve
```

Then open `http://localhost:8080`.

## Debug logging

SwiftReader exposes a simple debug utility in the browser console. To enable extra logging:

```js
window.swiftreaderDebug.enableDiagnostics({ storage: true, pdfUpload: true });
```

Disable by refreshing the page.

## Testing imports

Use a small set of sample files:

- A short `.txt` file (a few paragraphs)
- A small `.pdf` (1–2 pages)
- A basic `.epub` (single chapter)

Verify:

- Files import without errors
- Viewer loads correctly
- RSVP plays and pauses
- Export/import round-trip succeeds

## Reproducing issues

When reporting a bug:

1. Capture exact steps.
2. Record browser + OS + device.
3. Copy console errors.
4. Provide a sample file or file type + size.

## GitHub Pages deployment

SwiftReader is GitHub Pages friendly. You can deploy directly from `main` with no build step.

## Dependency updates

Third-party dependencies live in `vendor/` and CDN references in the app. When updating:

- Test PDF import + rendering (pdf.js)
- Test EPUB import + rendering (epub.js + JSZip)
- Confirm no new network calls are introduced
- Update any version notes in `CHANGELOG.md`
