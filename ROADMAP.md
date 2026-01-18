# Roadmap

SwiftReader’s roadmap is intentionally modest and privacy-first. Each phase lists success criteria to keep scope realistic.

## Phase 1: MVP stability & import reliability

- **Harden imports (TXT/PDF/EPUB).**
  - *Success:* 95% of sample files import without errors; clear error messages when they don’t.
- **Reduce crashes and regressions.**
  - *Success:* No uncaught exceptions in common flows; error toast for failures.

## Phase 2: Viewer UX polish

- **Better fit modes & scrolling.**
  - *Success:* Fit width/page works reliably on desktop and mobile.
- **Fullscreen and gestures.**
  - *Success:* Fullscreen toggles correctly; pinch-zoom and pan feel smooth.

## Phase 3: Reading flow improvements

- **Chapter navigation & progress markers.**
  - *Success:* Users can jump to chapters and see progress in both viewer and RSVP.
- **Bookmarks.**
  - *Success:* Users can save and return to multiple positions per book.

## Phase 4: Offline-friendly experience

- **PWA install (optional).**
  - *Success:* App can be installed and works offline without a server.

## Phase 5: Storage enhancements (optional)

- **IndexedDB file storage.**
  - *Success:* Large files load reliably without localStorage limitations.

## Phase 6: Extensibility (optional)

- **Themes and plugin hooks.**
  - *Success:* UI theming without changing core logic; documented extension points.
