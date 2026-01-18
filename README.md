# SwiftReader

SwiftReader is a privacy-first speed reading web app with RSVP, PDF/EPUB viewing, a local library, and notes.

**Demo:** https://<your-username>.github.io/SwiftReader/ (GitHub Pages)

## Screenshots

![Reader view](/docs/assets/screenshot-reader.png)
![Library view](/docs/assets/screenshot-library.png)
![Notes view](/docs/assets/screenshot-notes.png)

## Key features (today)

- Local-first library with import/export (no accounts).
- RSVP (rapid serial visual presentation) reader with adjustable speed.
- PDF viewer with page navigation, zoom, fit modes, and fullscreen.
- EPUB viewer with in-browser rendering.
- Notes linked to books and reading positions.
- Progress tracking per book.

## Who it’s for

- Students and researchers who read a lot of PDFs.
- Language learners practicing paced reading.
- Professionals scanning reports and articles.
- Readers looking for focus/ADHD-friendly reading flows.

## How it works

SwiftReader keeps all data in your browser. You can import text, PDFs, or EPUBs into your local library, open a book in the viewer, and optionally use the RSVP mode to read word-by-word with pacing controls. Notes can be captured during reading and are tied to the book and position for quick recall.

## Privacy model

- **Local-first:** everything is stored in your browser (localStorage + IndexedDB).
- **No tracking:** no analytics, no ads, no accounts.
- **Exports are explicit:** data only leaves your device when you export.

Read more in [docs/privacy.md](docs/privacy.md).

## Quick start

### Option 1: Open directly

1. Clone the repo.
2. Open `index.html` in your browser.

### Option 2: Run a tiny local server (recommended)

```bash
# Python
python -m http.server 8080

# or Node
npx serve
```

Then open `http://localhost:8080`.

## Usage guide

### Importing files

- Use **Add Book** in the Library to import:
  - **PDF** (`.pdf`)
  - **EPUB** (`.epub`)
  - **Text** (`.txt`) or paste text

### Reader controls

- **RSVP:** play/pause, speed (WPM), and progress.
- **Viewer:** page navigation, fit width/page, zoom, and fullscreen (PDF).
- **Sync:** optionally sync RSVP progress with PDF page.

### Notes

- Add notes from the reader.
- View and edit notes in the **Notes** section.
- Notes are linked to a book and reading position.

### Export/import

- Export your full library and notes from the sidebar.
- Import merges or replaces existing data (you choose).

## Accessibility commitments

- Keyboard-friendly controls where possible.
- Touch gestures for PDF pan/zoom.
- RSVP mode for reduced eye movement.

If you spot accessibility issues, please open an issue.

## Tech stack

- Vanilla **HTML/CSS/JS** (no framework)
- [pdf.js](https://mozilla.github.io/pdf.js/) for PDF rendering
- [epub.js](https://github.com/futurepress/epub.js/) for EPUB rendering
- [JSZip](https://stuk.github.io/jszip/) for EPUB support

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, style conventions, and the definition of done.

Looking for a good first issue? Check the issue labels for **good first issue** and **help wanted**.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the short, realistic roadmap.

## License

MIT — see [LICENSE](LICENSE).

## Disclaimer

Reading speed varies by person and material. This tool is not medical advice. Take breaks and avoid eye strain.
