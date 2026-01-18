# Architecture

This document provides a lightweight overview of SwiftReader’s architecture and data model.

## High-level modules

### Storage

- **Primary stores:** `localStorage` for lightweight settings and state; **IndexedDB** for book contents and notes.
- **Schema + migrations:** A simple schema version is stored and migrations normalize older data structures when imported.
- **Export/import:** Users can export a JSON bundle of library, notes, and settings; import can merge or replace.

### Import pipeline

- **TXT / paste:** Text is tokenized and added as a book entry.
- **PDF:** pdf.js loads the document and extracts text; page count and metadata are stored.
- **EPUB:** epub.js + JSZip parse the archive and provide text extraction and rendering.

### PDF viewer

- pdf.js renders to a `<canvas>` with zoom, fit width/page, and fullscreen.
- Pan and pinch-zoom are supported for touch and trackpad usage.

### EPUB extraction

- epub.js renders into a DOM container.
- JSZip is required to open `.epub` archives.

### RSVP engine

- Tokenizes text and renders a single word at a time.
- Uses punctuation and paragraph pauses to improve readability.
- Maps RSVP word position to viewer progress where possible.

### Notes subsystem

- Notes are linked to a **book ID** and **word index** (or token index).
- Notes are visible in the reader and in a separate Notes view.

## Data model (simplified)

### Book

- `id`
- `title`, `author`, `tags`
- `sourceType` (`paste`, `txt`, `pdf`, `epub`)
- `text`, `tokens` (for RSVP)
- `progress` (word index, PDF page, timestamps)

### Note

- `id`
- `bookId`, `bookTitle`
- `wordIndex` or `index` (token index)
- `text`
- `createdAt`, `updatedAt`

### Settings

- `wpm`, `theme`, `readerMode`
- RSVP font and layout preferences

## Error handling philosophy

- **Never crash on parse:** fail with a user-friendly message.
- **Safe save:** normalize data before persisting.
- **Resilient imports:** ignore malformed entries and continue where possible.

## Performance considerations

- Large PDFs can be heavy to render; prefer fit-width and avoid excessive zoom on low-memory devices.
- EPUB parsing can be slow on very large archives; allow time for initial load.
- RSVP tokenization happens locally; very large text may take a moment to process.
