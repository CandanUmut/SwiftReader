# Privacy

SwiftReader is local-first by design. Your data stays on your device unless you explicitly export it.

## What data is stored locally

SwiftReader stores the following in your browser:

- Library metadata (titles, authors, tags)
- Book content and tokens (for RSVP)
- Reading progress (word index, PDF page)
- Notes linked to books
- Settings (WPM, reader mode, theme)

Storage uses **localStorage** and **IndexedDB** for reliability.

## Export and import behavior

- **Export:** Creates a JSON file containing library, notes, and settings.
- **Import:** You can merge with existing data or replace it entirely.
- **No automatic backups:** You control when and where exports are stored.

## No analytics, no remote servers

SwiftReader does not include analytics, tracking pixels, or account systems. The app does not send your data anywhere.

## Risks to be aware of

- **Shared computers:** Anyone with access to your browser profile can see your library.
- **Cleared storage:** Clearing browser data will remove your library and notes.

## Best practices

- Export backups regularly, especially before clearing browser storage.
- Use device encryption and OS-level protections.
- Avoid importing sensitive documents on shared devices.
