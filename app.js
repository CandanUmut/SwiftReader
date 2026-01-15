/* =========================================================
   SwiftReader - app.js
   Vanilla JS prototype (GitHub Pages friendly)
   - Local-first library (books) + notes
   - RSVP reader with ORP (red pivot letter)
   - Import: Paste + TXT/MD (EPUB/PDF stubs for later)
   - Export/Import JSON
   - Theme toggle (system/light/dark)
   ========================================================= */

(() => {
  "use strict";

  /* ---------------------------
     Helpers
  --------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const nowISO = () => new Date().toISOString();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  function uid(prefix = "id") {
    // Fast, stable enough for local storage
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function formatMs(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function normalizeText(raw) {
    if (!raw) return "";
    // Normalize line endings and remove excessive whitespace
    let t = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    // Fix hyphenated line breaks: "some-\nthing" -> "something"
    t = t.replace(/(\w)-\n(\w)/g, "$1$2");

    // Convert multiple newlines into paragraph breaks marker
    // We'll preserve paragraph boundaries as "\n\n"
    t = t.replace(/[ \t]+\n/g, "\n");
    t = t.replace(/\n{3,}/g, "\n\n");

    // Trim trailing spaces per line
    t = t.split("\n").map(line => line.trimEnd()).join("\n");

    // Trim overall
    return t.trim();
  }

  function estimateReadMinutes(wordCount, wpm = 300) {
    if (!wordCount || !wpm) return 0;
    return Math.max(1, Math.ceil(wordCount / wpm));
  }

  function fileToText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("File read error"));
      reader.onload = () => resolve(String(reader.result || ""));
      reader.readAsText(file);
    });
  }

  /* ---------------------------
     Tokenization
     We store tokens as objects:
     { t: "word", kind: "word" }
     { t: ".", kind: "punct" }
     { t: "\n\n", kind: "para" }
  --------------------------- */
  const PUNCT_RE = /^[,.;:!?]$/;
  const HARD_PUNCT_RE = /^[.!?]$/;
  const SOFT_PUNCT_RE = /^[,;:]$/;

  function tokenize(text) {
    const t = normalizeText(text);
    if (!t) return [];

    // Preserve paragraph breaks
    const parts = t.split(/\n{2,}/g);
    const tokens = [];

    for (let p = 0; p < parts.length; p++) {
      const para = parts[p].trim();
      if (!para) continue;

      // Split into "words" and punctuation, keeping punctuation as separate tokens
      // This is a simple and reliable tokenizer for MVP.
      // Examples:
      // "Hello, world!" => ["Hello", ",", "world", "!"]
      const raw = para
        .replace(/([,.;:!?])/g, " $1 ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean);

      for (const r of raw) {
        if (PUNCT_RE.test(r)) tokens.push({ t: r, kind: "punct" });
        else tokens.push({ t: r, kind: "word" });
      }

      // Paragraph break (except after last)
      if (p < parts.length - 1) {
        tokens.push({ t: "\n\n", kind: "para" });
      }
    }

    return tokens;
  }

  function countWords(tokens) {
    return tokens.reduce((acc, tok) => acc + (tok.kind === "word" ? 1 : 0), 0);
  }

  /* ---------------------------
     ORP (Optimal Recognition Point)
     Common mapping based on word length
  --------------------------- */
  function getOrpIndex(word) {
    const w = word || "";
    const len = w.length;

    if (len <= 1) return 0;
    if (len <= 2) return 0;     // 1st char
    if (len <= 5) return 1;     // 2nd
    if (len <= 9) return 2;     // 3rd
    if (len <= 13) return 3;    // 4th
    return 4;                   // 5th
  }

  function renderRSVPWord(word) {
    // Returns { left, pivot, right }
    if (!word) return { left: "", pivot: "•", right: "" };
    const idx = clamp(getOrpIndex(word), 0, Math.max(0, word.length - 1));
    const left = word.slice(0, idx);
    const pivot = word[idx] || "•";
    const right = word.slice(idx + 1);
    return { left, pivot, right };
  }

  /* ---------------------------
     Storage Model
     State is stored in localStorage key:
     swiftreader_v1
  --------------------------- */
  const STORE_KEY = "swiftreader_v1";

  const defaultState = () => ({
    version: 1,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    settings: {
      theme: "system", // "system" | "dark" | "light"
      defaultWpm: 300,
      fontSize: 46,
      fontFamily: "system", // system | serif | mono
      autoPause: true,
      tapControls: true,
      rememberLastBook: true,
      punctuationPause: 80, // 0-200 slider value
    },
    library: {
      books: [], // Book[]
      lastOpenedBookId: null,
    },
    notes: [] // Note[]
  });

  // Book shape:
  // {
  //   id, title, author, tags:[], addedAt, updatedAt,
  //   sourceType:"paste"|"txt"|"md"|"epub"|"pdf",
  //   text, tokens, wordCount,
  //   progress: { index:number, updatedAt, bookmarks: [{id, index, createdAt}] },
  //   stats: { openedAt, lastSessionAt, totalReadWords }
  // }
  //
  // Note shape:
  // { id, bookId, bookTitle, index, excerpt, text, createdAt, updatedAt }

  let state = loadState();

  function loadState() {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== "object") return defaultState();

    // Merge shallowly to avoid missing keys
    const base = defaultState();
    const merged = {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      library: { ...base.library, ...(parsed.library || {}) },
      notes: Array.isArray(parsed.notes) ? parsed.notes : []
    };

    // Ensure books array
    if (!Array.isArray(merged.library.books)) merged.library.books = [];
    // Ensure each book has required fields
    merged.library.books = merged.library.books.map(b => normalizeBook(b));
    merged.updatedAt = nowISO();
    return merged;
  }

  function saveState() {
    state.updatedAt = nowISO();
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    updateStorageEstimate();
  }

  function normalizeBook(b) {
    const nb = {
      id: b?.id || uid("book"),
      title: (b?.title || "Untitled").trim() || "Untitled",
      author: (b?.author || "").trim(),
      tags: Array.isArray(b?.tags) ? b.tags : [],
      addedAt: b?.addedAt || nowISO(),
      updatedAt: b?.updatedAt || nowISO(),
      sourceType: b?.sourceType || "paste",
      text: typeof b?.text === "string" ? b.text : "",
      tokens: Array.isArray(b?.tokens) ? b.tokens : [],
      wordCount: typeof b?.wordCount === "number" ? b.wordCount : 0,
      progress: {
        index: typeof b?.progress?.index === "number" ? b.progress.index : 0,
        updatedAt: b?.progress?.updatedAt || nowISO(),
        bookmarks: Array.isArray(b?.progress?.bookmarks) ? b.progress.bookmarks : []
      },
      stats: {
        openedAt: b?.stats?.openedAt || null,
        lastSessionAt: b?.stats?.lastSessionAt || null,
        totalReadWords: typeof b?.stats?.totalReadWords === "number" ? b.stats.totalReadWords : 0
      }
    };

    // If tokens missing but text exists, generate tokens on load
    if ((!nb.tokens || nb.tokens.length === 0) && nb.text) {
      nb.tokens = tokenize(nb.text);
      nb.wordCount = countWords(nb.tokens);
    }

    // Clamp progress
    nb.progress.index = clamp(nb.progress.index, 0, Math.max(0, nb.tokens.length - 1));
    return nb;
  }

  function upsertBook(book) {
    const idx = state.library.books.findIndex(b => b.id === book.id);
    if (idx >= 0) state.library.books[idx] = normalizeBook(book);
    else state.library.books.unshift(normalizeBook(book));
    saveState();
  }

  function deleteBook(bookId) {
    state.library.books = state.library.books.filter(b => b.id !== bookId);
    // Remove notes for that book
    state.notes = state.notes.filter(n => n.bookId !== bookId);
    if (state.library.lastOpenedBookId === bookId) state.library.lastOpenedBookId = null;
    saveState();
  }

  function getBook(bookId) {
    return state.library.books.find(b => b.id === bookId) || null;
  }

  function upsertNote(note) {
    const idx = state.notes.findIndex(n => n.id === note.id);
    const normalized = {
      id: note.id || uid("note"),
      bookId: note.bookId,
      bookTitle: note.bookTitle || "",
      index: typeof note.index === "number" ? note.index : 0,
      excerpt: note.excerpt || "",
      text: (note.text || "").trim(),
      createdAt: note.createdAt || nowISO(),
      updatedAt: nowISO()
    };
    if (idx >= 0) state.notes[idx] = normalized;
    else state.notes.unshift(normalized);
    saveState();
    return normalized;
  }

  /* ---------------------------
     DOM References
  --------------------------- */
  // Theme / help
  const themeToggleBtn = $("#theme-toggle");
  const helpBtn = $("#help-btn");
  const modalHelp = $("#modal-help");

  // Nav buttons
  const navButtons = $$(".nav-item");

  // Library view elements
  const addBookBtn = $("#add-book-btn");
  const tabFile = $("#tab-file");
  const tabPaste = $("#tab-paste");
  const panelFile = $("#panel-file");
  const panelPaste = $("#panel-paste");

  const fileDrop = $("#file-drop");
  const fileInput = $("#file-input");
  const demoLoadBtn = $("#demo-load-btn");
  const importTitle = $("#import-title");
  const importAuthor = $("#import-author");
  const importTags = $("#import-tags");
  const importConfirmBtn = $("#import-confirm-btn");
  const importClearBtn = $("#import-clear-btn");

  const pasteText = $("#paste-text");
  const pasteTitle = $("#paste-title");
  const pasteAddBtn = $("#paste-add-btn");
  const pasteClearBtn = $("#paste-clear-btn");

  const librarySearch = $("#library-search");
  const librarySort = $("#library-sort");
  const bookList = $("#book-list");
  const libraryEmpty = $("#library-empty");
  const storageEstimate = $("#storage-estimate");
  const dangerResetBtn = $("#danger-reset-btn");

  const exportBtn = $("#export-btn");
  const importDataBtn = $("#import-data-btn");

  // Reader view elements
  const openLibraryBtn = $("#open-library-btn");
  const readerBookTitle = $("#reader-book-title");
  const readerBookSub = $("#reader-book-sub");
  const wpmValue = $("#wpm-value");
  const readerProgressEl = $("#reader-progress");

  const rsvpLeft = $("#rsvp-left");
  const rsvpPivot = $("#rsvp-pivot");
  const rsvpRight = $("#rsvp-right");
  const rsvpSubline = $("#rsvp-subline");

  const btnBackSent = $("#btn-back-sent");
  const btnBack = $("#btn-back");
  const btnPlay = $("#btn-play");
  const btnForward = $("#btn-forward");
  const btnForwardSent = $("#btn-forward-sent");
  const btnMark = $("#btn-mark");
  const btnAddNote = $("#btn-add-note");

  const wpmSlider = $("#wpm-slider");
  const pauseSlider = $("#pause-slider");

  const statSession = $("#stat-session");
  const statWords = $("#stat-words");
  const statAvgWpm = $("#stat-avgwpm");
  const statPauses = $("#stat-pauses");

  const quickNote = $("#quick-note");
  const saveNoteBtn = $("#save-note-btn");
  const clearNoteBtn = $("#clear-note-btn");
  const noteList = $("#note-list");

  // Notes view elements
  const notesSearch = $("#notes-search");
  const notesFilterBook = $("#notes-filter-book");
  const notesSort = $("#notes-sort");
  const notesEmpty = $("#notes-empty");
  const notesAllList = $("#notes-all-list");

  const notePreviewBook = $("#note-preview-book");
  const notePreviewText = $("#note-preview-text");
  const noteEdit = $("#note-edit");
  const noteUpdateBtn = $("#note-update-btn");
  const noteDeleteBtn = $("#note-delete-btn");

  // Settings view elements
  const defaultWpmInput = $("#default-wpm");
  const fontSizeSlider = $("#font-size");
  const fontFamilySelect = $("#font-family");
  const autoPauseCheckbox = $("#auto-pause");
  const tapControlsCheckbox = $("#tap-controls");
  const rememberLastBookCheckbox = $("#remember-last-book");
  const encryptExportCheckbox = $("#encrypt-export"); // stub

  const settingsExportBtn = $("#settings-export-btn");
  const settingsImportBtn = $("#settings-import-btn");
  const settingsResetBtn = $("#settings-reset-btn");

  // Footer buttons (optional)
  const aboutBtn = $("#about-btn");
  const shortcutsBtn = $("#shortcuts-btn");

  /* ---------------------------
     UI State
  --------------------------- */
  let currentView = "library";
  let selectedBookId = null;

  // Reader session runtime
  const reader = {
    isPlaying: false,
    timer: null,
    startedAt: null,          // timestamp ms for session
    elapsedBefore: 0,         // ms accumulated before last play
    sessionWords: 0,          // word tokens shown during session
    pauses: 0,                // number of manual pauses
    lastTickAt: null
  };

  // Selected note in Notes view
  let selectedNoteId = null;

  // Import buffer for file panel
  let importBuffer = {
    files: [],
    text: "",
    sourceType: null,
    suggestedTitle: ""
  };

  /* ---------------------------
     Init
  --------------------------- */
  applyThemeFromSettings();
  applyReaderStyleSettings();
  hydrateSettingsUI();
  wireEvents();
  renderAll();
  restoreLastBookIfNeeded();

  /* ---------------------------
     Event Wiring
  --------------------------- */
  function wireEvents() {
    // Theme toggle cycles: system -> dark -> light -> system
    themeToggleBtn.addEventListener("click", () => {
      const cur = state.settings.theme || "system";
      const next = cur === "system" ? "dark" : cur === "dark" ? "light" : "system";
      state.settings.theme = next;
      saveState();
      applyThemeFromSettings();
    });

    // Help modal
    helpBtn.addEventListener("click", () => openModal(modalHelp));
    modalHelp.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.close === "true") closeModal(modalHelp);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!modalHelp.hidden) closeModal(modalHelp);
      }
    });

    // Nav
    navButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        if (!view) return;
        setView(view);
      });
    });

    openLibraryBtn.addEventListener("click", () => setView("library"));

    // Import tabs
    tabFile.addEventListener("click", () => setImportTab("file"));
    tabPaste.addEventListener("click", () => setImportTab("paste"));

    // File drop zone
    fileDrop.addEventListener("click", () => fileInput.click());
    fileDrop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") fileInput.click();
    });

    // Drag & drop
    ["dragenter", "dragover"].forEach(type => {
      fileDrop.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileDrop.style.borderColor = "color-mix(in srgb, var(--primary) 40%, var(--border))";
      });
    });
    ["dragleave", "drop"].forEach(type => {
      fileDrop.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileDrop.style.borderColor = "";
      });
    });
    fileDrop.addEventListener("drop", async (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length === 0) return;
      await handleFilesSelected(files);
    });

    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) return;
      await handleFilesSelected(files);
      fileInput.value = "";
    });

    demoLoadBtn.addEventListener("click", () => {
      const demo = `
SwiftReader Demo — RSVP speed reading

This is a short demo text. Start at 300 WPM, then increase gradually.
Notice the red pivot letter: your eyes stay fixed, and comprehension stays smooth.

Try:
- Space to Play/Pause
- Arrow keys to step
- Up/Down to change speed
- Add a note while reading

Paragraph two begins here. Commas, periods, and paragraph breaks can pause slightly to support comprehension.
`;
      importBuffer = {
        files: [],
        text: normalizeText(demo),
        sourceType: "paste",
        suggestedTitle: "SwiftReader Demo"
      };
      importTitle.value = "SwiftReader Demo";
      importAuthor.value = "";
      importTags.value = "demo, rsvp";
    });

    importConfirmBtn.addEventListener("click", async () => {
      const title = (importTitle.value || importBuffer.suggestedTitle || "Untitled").trim() || "Untitled";
      const author = (importAuthor.value || "").trim();
      const tags = (importTags.value || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

      if (!importBuffer.text) {
        // No file selected? Let user still add from file panel if they filled nothing.
        alert("Please choose a TXT/MD file (or load demo text) first.");
        return;
      }

      const book = createBookFromText({
        title,
        author,
        tags,
        text: importBuffer.text,
        sourceType: importBuffer.sourceType || "paste"
      });

      upsertBook(book);
      clearFileImportUI();

      // Auto-open in reader
      openBookInReader(book.id);
      setView("reader");
    });

    importClearBtn.addEventListener("click", () => clearFileImportUI());

    // Paste import
    pasteAddBtn.addEventListener("click", () => {
      const text = normalizeText(pasteText.value || "");
      const title = (pasteTitle.value || "Pasted Text").trim() || "Pasted Text";
      if (!text) {
        alert("Paste some text first.");
        return;
      }
      const book = createBookFromText({
        title,
        author: "",
        tags: ["paste"],
        text,
        sourceType: "paste"
      });
      upsertBook(book);
      pasteText.value = "";
      pasteTitle.value = "";
      openBookInReader(book.id);
      setView("reader");
    });

    pasteClearBtn.addEventListener("click", () => {
      pasteText.value = "";
      pasteTitle.value = "";
    });

    // Library interactions
    librarySearch.addEventListener("input", () => renderLibraryList());
    librarySort.addEventListener("change", () => renderLibraryList());

    dangerResetBtn.addEventListener("click", () => {
      if (!confirm("This will delete all local books and notes for SwiftReader. Continue?")) return;
      state = defaultState();
      saveState();
      stopReader(true);
      selectedBookId = null;
      selectedNoteId = null;
      applyThemeFromSettings();
      applyReaderStyleSettings();
      hydrateSettingsUI();
      renderAll();
      setView("library");
    });

    // Sidebar export/import
    exportBtn.addEventListener("click", () => exportData());
    importDataBtn.addEventListener("click", () => importData());

    // Reader controls
    btnPlay.addEventListener("click", () => togglePlay());
    btnBack.addEventListener("click", () => stepWords(-3));
    btnForward.addEventListener("click", () => stepWords(+3));
    btnBackSent.addEventListener("click", () => stepSentence(-1));
    btnForwardSent.addEventListener("click", () => stepSentence(+1));
    btnMark.addEventListener("click", () => addBookmark());
    btnAddNote.addEventListener("click", () => openAddNoteFromReader());

    wpmSlider.addEventListener("input", () => {
      const v = Number(wpmSlider.value);
      state.settings.defaultWpm = v;
      wpmValue.textContent = String(v);
      saveState();
    });

    pauseSlider.addEventListener("input", () => {
      const v = Number(pauseSlider.value);
      state.settings.punctuationPause = v;
      saveState();
    });

    // Reader quick note box
    saveNoteBtn.addEventListener("click", () => {
      const text = (quickNote.value || "").trim();
      if (!selectedBookId) {
        alert("Select a book first.");
        return;
      }
      if (!text) return;
      const book = getBook(selectedBookId);
      const idx = getCurrentTokenIndex();
      const excerpt = makeExcerpt(book, idx);
      upsertNote({
        id: null,
        bookId: book.id,
        bookTitle: book.title,
        index: idx,
        excerpt,
        text
      });
      quickNote.value = "";
      renderReaderNotes();
      renderNotesView();
    });

    clearNoteBtn.addEventListener("click", () => (quickNote.value = ""));

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Ignore if typing in inputs/textareas/selects
      const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : "";
      const typing = tag === "input" || tag === "textarea" || tag === "select";
      if (typing) return;
      if (!$("#view-reader").classList.contains("is-active")) {
        // Allow space to open reader quickly? keep simple: only if in reader.
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepWords(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        stepWords(+1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        bumpWpm(+10);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        bumpWpm(-10);
      }
    });

    // Tap controls (mobile)
    $(".rsvp-frame")?.addEventListener("click", (e) => {
      if (!state.settings.tapControls) return;
      if (!$("#view-reader").classList.contains("is-active")) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const third = rect.width / 3;
      if (x < third) stepWords(-1);
      else if (x > third * 2) stepWords(+1);
      else togglePlay();
    });

    // Notes view
    notesSearch.addEventListener("input", () => renderNotesView());
    notesFilterBook.addEventListener("change", () => renderNotesView());
    notesSort.addEventListener("change", () => renderNotesView());

    noteUpdateBtn.addEventListener("click", () => {
      if (!selectedNoteId) return;
      const note = state.notes.find(n => n.id === selectedNoteId);
      if (!note) return;
      const text = (noteEdit.value || "").trim();
      if (!text) {
        alert("Note text cannot be empty.");
        return;
      }
      upsertNote({ ...note, text });
      renderNotesView();
      // Keep selection
      selectNote(selectedNoteId);
    });

    noteDeleteBtn.addEventListener("click", () => {
      if (!selectedNoteId) return;
      const note = state.notes.find(n => n.id === selectedNoteId);
      if (!note) return;
      if (!confirm("Delete this note?")) return;
      state.notes = state.notes.filter(n => n.id !== selectedNoteId);
      saveState();
      selectedNoteId = null;
      clearNotePreview();
      renderNotesView();
      renderReaderNotes();
    });

    // Settings
    defaultWpmInput.addEventListener("change", () => {
      const v = clamp(Number(defaultWpmInput.value), 150, 1200);
      state.settings.defaultWpm = v;
      wpmSlider.value = String(v);
      wpmValue.textContent = String(v);
      saveState();
    });

    fontSizeSlider.addEventListener("input", () => {
      const v = clamp(Number(fontSizeSlider.value), 22, 72);
      state.settings.fontSize = v;
      applyReaderStyleSettings();
      saveState();
    });

    fontFamilySelect.addEventListener("change", () => {
      state.settings.fontFamily = fontFamilySelect.value;
      applyReaderStyleSettings();
      saveState();
    });

    autoPauseCheckbox.addEventListener("change", () => {
      state.settings.autoPause = !!autoPauseCheckbox.checked;
      saveState();
    });

    tapControlsCheckbox.addEventListener("change", () => {
      state.settings.tapControls = !!tapControlsCheckbox.checked;
      saveState();
    });

    rememberLastBookCheckbox.addEventListener("change", () => {
      state.settings.rememberLastBook = !!rememberLastBookCheckbox.checked;
      saveState();
    });

    // Export/import from settings too
    settingsExportBtn.addEventListener("click", () => exportData());
    settingsImportBtn.addEventListener("click", () => importData());

    settingsResetBtn.addEventListener("click", () => dangerResetBtn.click());

    // Footer optional hooks
    aboutBtn.addEventListener("click", () => {
      alert("SwiftReader — local-first speed reading prototype.\n\nNo accounts. No tracking. Data stays in your browser unless you export.");
    });
    shortcutsBtn.addEventListener("click", () => {
      alert("Shortcuts (Reader)\n\nSpace: Play/Pause\n← / →: Step word\n↑ / ↓: Speed\n");
    });
  }

  /* ---------------------------
     Views
  --------------------------- */
  function setView(view) {
    if (!view) return;
    currentView = view;

    // Stop reading when leaving reader? We pause but keep state.
    if (view !== "reader") {
      if (reader.isPlaying) stopReader(false);
    }

    // Toggle nav active
    navButtons.forEach(btn => {
      const isActive = btn.dataset.view === view;
      btn.classList.toggle("is-active", isActive);
      if (isActive) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });

    // Toggle view sections
    $$(".view").forEach(v => {
      const isActive = v.dataset.view === view;
      v.classList.toggle("is-active", isActive);
      v.hidden = !isActive;
    });

    // Render view-specific
    if (view === "library") renderLibraryList();
    if (view === "reader") renderReader();
    if (view === "notes") renderNotesView();
    if (view === "settings") hydrateSettingsUI();
  }

  function setImportTab(which) {
    const isFile = which === "file";
    tabFile.classList.toggle("is-active", isFile);
    tabPaste.classList.toggle("is-active", !isFile);

    tabFile.setAttribute("aria-selected", String(isFile));
    tabPaste.setAttribute("aria-selected", String(!isFile));

    panelFile.classList.toggle("is-active", isFile);
    panelPaste.classList.toggle("is-active", !isFile);

    panelFile.hidden = !isFile;
    panelPaste.hidden = isFile;
  }

  /* ---------------------------
     Modal
  --------------------------- */
  function openModal(el) {
    if (!el) return;
    el.hidden = false;
    // Focus first close button
    const btn = el.querySelector("[data-close='true']");
    btn?.focus();
  }

  function closeModal(el) {
    if (!el) return;
    el.hidden = true;
  }

  /* ---------------------------
     Theme
  --------------------------- */
  function applyThemeFromSettings() {
    const theme = state.settings.theme || "system";
    const root = document.documentElement;

    if (theme === "system") {
      root.removeAttribute("data-theme");
      themeToggleBtn.querySelector(".icon").textContent = "☾";
      return;
    }

    root.setAttribute("data-theme", theme);
    themeToggleBtn.querySelector(".icon").textContent = theme === "dark" ? "☾" : "☀";
  }

  /* ---------------------------
     Reader style settings
  --------------------------- */
  function applyReaderStyleSettings() {
    const root = document.documentElement;

    // Font size affects RSVP display
    const size = clamp(Number(state.settings.fontSize || 46), 22, 72);
    root.style.setProperty("--rsvpFontSize", `${size}px`);

    // Font family for RSVP only (safe)
    let fam = "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    if (state.settings.fontFamily === "serif") fam = "ui-serif, Georgia, Cambria, Times New Roman, Times, serif";
    if (state.settings.fontFamily === "mono") fam = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace";
    $("#rsvp-word").style.fontFamily = fam;
  }

  function hydrateSettingsUI() {
    defaultWpmInput.value = String(state.settings.defaultWpm || 300);
    wpmSlider.value = String(state.settings.defaultWpm || 300);
    wpmValue.textContent = String(state.settings.defaultWpm || 300);

    fontSizeSlider.value = String(state.settings.fontSize || 46);
    fontFamilySelect.value = state.settings.fontFamily || "system";

    autoPauseCheckbox.checked = !!state.settings.autoPause;
    tapControlsCheckbox.checked = !!state.settings.tapControls;
    rememberLastBookCheckbox.checked = !!state.settings.rememberLastBook;

    pauseSlider.value = String(state.settings.punctuationPause ?? 80);
  }

  /* ---------------------------
     Storage estimate (best-effort)
  --------------------------- */
  async function updateStorageEstimate() {
    try {
      if (!navigator.storage || !navigator.storage.estimate) {
        storageEstimate.textContent = "localStorage";
        return;
      }
      const { usage, quota } = await navigator.storage.estimate();
      if (!quota || !usage) {
        storageEstimate.textContent = "localStorage/IndexedDB";
        return;
      }
      const usedMB = (usage / (1024 * 1024)).toFixed(1);
      const quotaMB = (quota / (1024 * 1024)).toFixed(0);
      storageEstimate.textContent = `${usedMB}MB / ~${quotaMB}MB`;
    } catch {
      storageEstimate.textContent = "localStorage/IndexedDB";
    }
  }

  /* ---------------------------
     Import handling
  --------------------------- */
  async function handleFilesSelected(files) {
    // For MVP: accept first text-like file. Multiple support can be added later.
    // Accept .txt, .md. For .epub/.pdf we show a friendly message.
    const supported = files.filter(f => {
      const name = (f.name || "").toLowerCase();
      return name.endsWith(".txt") || name.endsWith(".md");
    });

    const epubPdf = files.filter(f => {
      const name = (f.name || "").toLowerCase();
      return name.endsWith(".epub") || name.endsWith(".pdf");
    });

    if (epubPdf.length > 0 && supported.length === 0) {
      alert("EPUB/PDF import is coming next. For V1 reliability, please use TXT or Paste.");
      return;
    }

    if (supported.length === 0) {
      alert("Please select a .txt or .md file for this prototype (or use Paste).");
      return;
    }

    const f = supported[0];
    const name = f.name || "Untitled";
    const baseTitle = name.replace(/\.(txt|md)$/i, "");
    const text = await fileToText(f);

    importBuffer = {
      files: [f],
      text: normalizeText(text),
      sourceType: name.toLowerCase().endsWith(".md") ? "md" : "txt",
      suggestedTitle: baseTitle
    };

    // Pre-fill title if blank
    if (!importTitle.value.trim()) importTitle.value = baseTitle;
  }

  function clearFileImportUI() {
    importTitle.value = "";
    importAuthor.value = "";
    importTags.value = "";
    importBuffer = { files: [], text: "", sourceType: null, suggestedTitle: "" };
  }

  function createBookFromText({ title, author, tags, text, sourceType }) {
    const tokens = tokenize(text);
    const wc = countWords(tokens);
    const book = {
      id: uid("book"),
      title: title || "Untitled",
      author: author || "",
      tags: Array.isArray(tags) ? tags : [],
      addedAt: nowISO(),
      updatedAt: nowISO(),
      sourceType: sourceType || "paste",
      text,
      tokens,
      wordCount: wc,
      progress: { index: 0, updatedAt: nowISO(), bookmarks: [] },
      stats: { openedAt: null, lastSessionAt: null, totalReadWords: 0 }
    };
    return book;
  }

  /* ---------------------------
     Library rendering
  --------------------------- */
  function renderLibraryList() {
    const q = (librarySearch.value || "").trim().toLowerCase();
    const sort = librarySort.value || "recent";

    let books = [...state.library.books];

    // Filter
    if (q) {
      books = books.filter(b => {
        const hay = [
          b.title || "",
          b.author || "",
          ...(b.tags || [])
        ].join(" ").toLowerCase();
        return hay.includes(q);
      });
    }

    // Sort
    if (sort === "recent") {
      books.sort((a, b) => {
        const ar = a.stats?.lastSessionAt || a.stats?.openedAt || a.updatedAt || a.addedAt || "";
        const br = b.stats?.lastSessionAt || b.stats?.openedAt || b.updatedAt || b.addedAt || "";
        return String(br).localeCompare(String(ar));
      });
    } else if (sort === "added") {
      books.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
    } else if (sort === "title") {
      books.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    } else if (sort === "author") {
      books.sort((a, b) => String(a.author).localeCompare(String(b.author)));
    }

    // Render
    bookList.innerHTML = "";
    libraryEmpty.style.display = books.length ? "none" : "block";

    for (const b of books) {
      const li = document.createElement("li");
      li.className = "book-item";

      const btn = document.createElement("button");
      btn.className = "book-card";
      btn.type = "button";
      btn.addEventListener("click", () => {
        openBookInReader(b.id);
        setView("reader");
      });

      const meta = document.createElement("div");
      meta.className = "book-meta";

      const title = document.createElement("div");
      title.className = "book-title";
      title.textContent = b.title || "Untitled";

      const mins = estimateReadMinutes(b.wordCount || 0, state.settings.defaultWpm || 300);
      const sub = document.createElement("div");
      sub.className = "book-sub";
      sub.textContent = `${b.author ? b.author + " • " : ""}${b.wordCount || 0} words • ~${mins} min @${state.settings.defaultWpm || 300}wpm`;

      const tags = document.createElement("div");
      tags.className = "book-tags";
      (b.tags || []).slice(0, 4).forEach(t => {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = t;
        tags.appendChild(span);
      });

      meta.appendChild(title);
      meta.appendChild(sub);
      if ((b.tags || []).length) meta.appendChild(tags);

      const progWrap = document.createElement("div");
      progWrap.className = "book-progress";

      const pct = computeProgressPct(b);
      const pl = document.createElement("div");
      pl.className = "progress-label";
      pl.textContent = `${pct}%`;

      const bar = document.createElement("div");
      bar.className = "progress-bar";
      const fill = document.createElement("div");
      fill.className = "progress-fill";
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);

      progWrap.appendChild(pl);
      progWrap.appendChild(bar);

      btn.appendChild(meta);
      btn.appendChild(progWrap);

      // Context menu (right-click) / long press: simple confirm actions
      btn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const action = prompt(`Book actions:\n1) Delete\n2) Rename\n\nType 1 or 2`, "");
        if (action === "1") {
          if (confirm(`Delete "${b.title}" and its notes?`)) {
            deleteBook(b.id);
            renderAll();
          }
        } else if (action === "2") {
          const newTitle = prompt("New title:", b.title);
          if (newTitle && newTitle.trim()) {
            upsertBook({ ...b, title: newTitle.trim(), updatedAt: nowISO() });
            renderAll();
          }
        }
      });

      li.appendChild(btn);
      bookList.appendChild(li);
    }
  }

  function computeProgressPct(book) {
    const total = Math.max(1, (book.tokens || []).length);
    const idx = clamp(book.progress?.index ?? 0, 0, total - 1);
    return Math.round((idx / (total - 1)) * 100);
  }

  /* ---------------------------
     Reader logic
  --------------------------- */
  function restoreLastBookIfNeeded() {
    if (!state.settings.rememberLastBook) return;
    const lastId = state.library.lastOpenedBookId;
    if (!lastId) return;
    const b = getBook(lastId);
    if (!b) return;
    // Don't auto-switch view; just preload the book selection for quick start
    selectedBookId = b.id;
    renderReader();
  }

  function openBookInReader(bookId) {
    const book = getBook(bookId);
    if (!book) return;

    // Stop current playback
    stopReader(true);

    selectedBookId = book.id;
    if (state.settings.rememberLastBook) state.library.lastOpenedBookId = book.id;

    // Update book stats
    const updated = {
      ...book,
      updatedAt: nowISO(),
      stats: {
        ...book.stats,
        openedAt: book.stats.openedAt || nowISO(),
        lastSessionAt: nowISO()
      }
    };
    upsertBook(updated);

    // Sync reader sliders with settings
    wpmSlider.value = String(state.settings.defaultWpm || 300);
    pauseSlider.value = String(state.settings.punctuationPause ?? 80);
    wpmValue.textContent = String(state.settings.defaultWpm || 300);

    // Render
    renderReader();
    renderReaderNotes();
    renderNotesView();
    renderLibraryList();
  }

  function renderReader() {
    const book = selectedBookId ? getBook(selectedBookId) : null;

    if (!book) {
      readerBookTitle.textContent = "No book selected";
      readerBookSub.textContent = "Choose a book from Library";
      setRSVPDisplay("Ready", "•", "Set");
      readerProgressEl.textContent = "0%";
      rsvpSubline.textContent = "Tap space / play to start";
      rsvpSubline.hidden = false;
      btnPlay.disabled = true;
      return;
    }

    btnPlay.disabled = false;
    readerBookTitle.textContent = book.title || "Untitled";
    readerBookSub.textContent = `${book.author || "—"} • ${book.wordCount || 0} words`;

    // Render current token
    const idx = clamp(book.progress?.index ?? 0, 0, Math.max(0, book.tokens.length - 1));
    renderTokenAtIndex(book, idx);

    readerProgressEl.textContent = `${computeProgressPct(book)}%`;
  }

  function setRSVPDisplay(left, pivot, right) {
    rsvpLeft.textContent = left;
    rsvpPivot.textContent = pivot;
    rsvpRight.textContent = right;
  }

  function renderTokenAtIndex(book, idx) {
    const tok = book.tokens[idx];
    if (!tok) {
      setRSVPDisplay("End", "•", "Done");
      rsvpSubline.textContent = "End of book";
      rsvpSubline.hidden = false;
      stopReader(true);
      return;
    }

    if (tok.kind === "para") {
      // Show a short pause token
      setRSVPDisplay("", "¶", "");
      rsvpSubline.textContent = "Paragraph";
      rsvpSubline.hidden = false;
      return;
    }

    if (tok.kind === "punct") {
      setRSVPDisplay("", tok.t, "");
      rsvpSubline.textContent = "Punctuation";
      rsvpSubline.hidden = true;
      return;
    }

    // Word
    const { left, pivot, right } = renderRSVPWord(tok.t);
    setRSVPDisplay(left, pivot, right);
    rsvpSubline.hidden = true;
  }

  function getCurrentTokenIndex() {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return 0;
    return clamp(book.progress?.index ?? 0, 0, Math.max(0, book.tokens.length - 1));
  }

  function setTokenIndex(idx, { fromPlayback = false } = {}) {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;

    const clamped = clamp(idx, 0, Math.max(0, book.tokens.length - 1));
    const updated = {
      ...book,
      progress: {
        ...book.progress,
        index: clamped,
        updatedAt: nowISO()
      },
      stats: {
        ...book.stats,
        lastSessionAt: nowISO()
      }
    };

    // Track read words for session / total
    if (fromPlayback) {
      const tok = book.tokens[clamped];
      if (tok && tok.kind === "word") {
        updated.stats.totalReadWords = (updated.stats.totalReadWords || 0) + 1;
      }
    }

    upsertBook(updated);
    renderReader();
    renderLibraryList();
  }

  function togglePlay() {
    if (!selectedBookId) {
      setView("library");
      return;
    }
    if (reader.isPlaying) {
      stopReader(false);
    } else {
      startReader();
    }
  }

  function startReader() {
    const book = getBook(selectedBookId);
    if (!book) return;

    reader.isPlaying = true;
    btnPlay.setAttribute("aria-pressed", "true");
    btnPlay.textContent = "⏸ Pause";
    rsvpSubline.hidden = true;

    // Start session timer
    if (!reader.startedAt) {
      reader.startedAt = Date.now();
      reader.elapsedBefore = 0;
      reader.sessionWords = 0;
      reader.pauses = 0;
      statAvgWpm.textContent = "—";
      statPauses.textContent = "0";
      statWords.textContent = "0";
    } else {
      // resume
      reader.startedAt = Date.now();
    }

    // Kick tick loop
    scheduleNextTick(0);
    scheduleSessionUI();
  }

  function stopReader(hardStop) {
    if (reader.timer) {
      clearTimeout(reader.timer);
      reader.timer = null;
    }

    if (reader.isPlaying && !hardStop) {
      reader.pauses += 1;
      statPauses.textContent = String(reader.pauses);
    }

    if (reader.isPlaying) {
      // accumulate elapsed
      const elapsed = Date.now() - (reader.startedAt || Date.now());
      reader.elapsedBefore += elapsed;
    }

    reader.isPlaying = false;
    btnPlay.setAttribute("aria-pressed", "false");
    btnPlay.textContent = "▶ Play";

    if (hardStop) {
      reader.startedAt = null;
      reader.elapsedBefore = 0;
      reader.sessionWords = 0;
      reader.pauses = 0;
      statSession.textContent = "00:00";
      statWords.textContent = "0";
      statAvgWpm.textContent = "—";
      statPauses.textContent = "0";
    }
  }

  function scheduleSessionUI() {
    // Update session stats periodically while playing
    const tick = () => {
      if (!reader.isPlaying) return;
      const elapsed = reader.elapsedBefore + (Date.now() - (reader.startedAt || Date.now()));
      statSession.textContent = formatMs(elapsed);

      // Avg WPM
      const minutes = elapsed / 60000;
      if (minutes > 0.05) {
        const avg = Math.round(reader.sessionWords / minutes);
        statAvgWpm.textContent = String(avg);
      }

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function scheduleNextTick(extraDelayMs) {
    if (!reader.isPlaying) return;
    const baseWpm = clamp(Number(wpmSlider.value || state.settings.defaultWpm || 300), 150, 1200);
    const baseInterval = 60000 / baseWpm;
    const delay = Math.max(0, baseInterval + (extraDelayMs || 0));

    reader.timer = setTimeout(() => {
      advancePlayback();
    }, delay);
  }

  function advancePlayback() {
    if (!reader.isPlaying) return;

    const book = getBook(selectedBookId);
    if (!book) return stopReader(true);

    let idx = getCurrentTokenIndex();
    if (idx >= book.tokens.length) {
      stopReader(true);
      return;
    }

    // Move to next meaningful token (including punctuation/para, but with pauses)
    idx = clamp(idx + 1, 0, Math.max(0, book.tokens.length - 1));
    const tok = book.tokens[idx];

    // If we just advanced into a word, count it for session
    if (tok && tok.kind === "word") {
      reader.sessionWords += 1;
      statWords.textContent = String(reader.sessionWords);
    }

    // Render token
    setTokenIndex(idx, { fromPlayback: tok?.kind === "word" });

    // Compute pause
    let extra = 0;
    const pauseIntensity = clamp(Number(pauseSlider.value ?? state.settings.punctuationPause ?? 80), 0, 200);

    if (state.settings.autoPause) {
      if (tok?.kind === "punct") {
        // soft vs hard punctuation
        if (HARD_PUNCT_RE.test(tok.t)) extra += 120 + pauseIntensity * 2;
        else if (SOFT_PUNCT_RE.test(tok.t)) extra += 40 + pauseIntensity;
      } else if (tok?.kind === "para") {
        extra += 200 + pauseIntensity * 3;
      }
    }

    // If at end, stop soon
    if (idx >= book.tokens.length - 1) {
      // show last token then stop
      scheduleNextTick(extra + 120);
      setTimeout(() => stopReader(true), extra + 250);
      return;
    }

    scheduleNextTick(extra);
  }

  function stepWords(delta) {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;

    // Pause on manual stepping (but don't hard reset session)
    if (reader.isPlaying) stopReader(false);

    const idx = getCurrentTokenIndex();
    const next = clamp(idx + delta, 0, Math.max(0, book.tokens.length - 1));
    setTokenIndex(next, { fromPlayback: false });
    renderReader();
    renderReaderNotes();
  }

  function stepSentence(dir) {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;

    if (reader.isPlaying) stopReader(false);

    const idx = getCurrentTokenIndex();
    const tokens = book.tokens;

    function isSentenceEnd(i) {
      const t = tokens[i];
      return t && t.kind === "punct" && HARD_PUNCT_RE.test(t.t);
    }

    let target = idx;

    if (dir < 0) {
      // Go back to previous sentence boundary, then forward one token
      let i = idx - 1;
      // Skip current punctuation if sitting on it
      while (i > 0 && (tokens[i]?.kind === "punct" || tokens[i]?.kind === "para")) i--;
      // Find previous end
      while (i > 0 && !isSentenceEnd(i)) i--;
      target = clamp(i + 1, 0, tokens.length - 1);
    } else {
      // Forward to next sentence end, then one token
      let i = idx + 1;
      while (i < tokens.length - 1 && !isSentenceEnd(i)) i++;
      target = clamp(i + 1, 0, tokens.length - 1);
    }

    setTokenIndex(target, { fromPlayback: false });
    renderReader();
    renderReaderNotes();
  }

  function bumpWpm(delta) {
    const cur = clamp(Number(wpmSlider.value || 300), 150, 1200);
    const next = clamp(cur + delta, 150, 1200);
    wpmSlider.value = String(next);
    wpmValue.textContent = String(next);
    state.settings.defaultWpm = next;
    saveState();
  }

  function addBookmark() {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;

    const idx = getCurrentTokenIndex();
    const bm = { id: uid("bm"), index: idx, createdAt: nowISO() };
    const updated = {
      ...book,
      progress: {
        ...book.progress,
        bookmarks: [bm, ...(book.progress.bookmarks || [])]
      },
      updatedAt: nowISO()
    };
    upsertBook(updated);

    alert("Bookmark saved.");
  }

  function openAddNoteFromReader() {
    // Focus note box and prefill with excerpt if empty
    if (!selectedBookId) return;
    const book = getBook(selectedBookId);
    const idx = getCurrentTokenIndex();
    const excerpt = makeExcerpt(book, idx);

    if (!quickNote.value.trim()) {
      quickNote.value = `(${excerpt})\n`;
    }
    quickNote.focus();
  }

  function makeExcerpt(book, idx) {
    if (!book || !book.tokens || book.tokens.length === 0) return "";
    // Build a short excerpt around idx using only word tokens
    const tokens = book.tokens;
    const words = [];
    let i = idx;
    // Step back a bit
    let back = 0;
    while (i > 0 && back < 8) {
      i--;
      if (tokens[i]?.kind === "word") {
        words.unshift(tokens[i].t);
        back++;
      }
    }
    // include current and forward
    let f = idx;
    let forward = 0;
    while (f < tokens.length && forward < 10) {
      if (tokens[f]?.kind === "word") {
        words.push(tokens[f].t);
        forward++;
      }
      f++;
    }
    return words.join(" ").slice(0, 140);
  }

  /* ---------------------------
     Notes rendering
  --------------------------- */
  function renderReaderNotes() {
    const bookId = selectedBookId;
    noteList.innerHTML = "";

    if (!bookId) return;

    const notes = state.notes
      .filter(n => n.bookId === bookId)
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));

    if (notes.length === 0) {
      const li = document.createElement("li");
      li.className = "note-item";
      li.innerHTML = `
        <div class="note-item-title">No notes yet</div>
        <div class="note-item-sub">Add a note while reading to see it here.</div>
      `;
      noteList.appendChild(li);
      return;
    }

    for (const n of notes.slice(0, 20)) {
      const li = document.createElement("li");
      li.className = "note-item";
      const title = document.createElement("div");
      title.className = "note-item-title";
      title.textContent = n.text.length > 70 ? n.text.slice(0, 70) + "…" : n.text;

      const sub = document.createElement("div");
      sub.className = "note-item-sub";
      sub.textContent = `${new Date(n.updatedAt || n.createdAt).toLocaleString()} • ${n.excerpt ? "“… " + n.excerpt.slice(0, 60) + " …”" : ""}`;

      li.appendChild(title);
      li.appendChild(sub);
      noteList.appendChild(li);
    }
  }

  function renderNotesView() {
    // Fill book filter options
    const prev = notesFilterBook.value || "all";
    notesFilterBook.innerHTML = `<option value="all">All books</option>`;
    for (const b of state.library.books) {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.title || "Untitled";
      notesFilterBook.appendChild(opt);
    }
    notesFilterBook.value = prev;

    // Apply filter/search/sort
    const q = (notesSearch.value || "").trim().toLowerCase();
    const bookFilter = notesFilterBook.value || "all";
    const sort = notesSort.value || "recent";

    let notes = [...state.notes];
    if (bookFilter !== "all") notes = notes.filter(n => n.bookId === bookFilter);
    if (q) {
      notes = notes.filter(n => (n.text || "").toLowerCase().includes(q) || (n.bookTitle || "").toLowerCase().includes(q));
    }

    if (sort === "recent") {
      notes.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
    } else {
      notes.sort((a, b) => String(a.updatedAt || a.createdAt).localeCompare(String(b.updatedAt || b.createdAt)));
    }

    // Render list
    notesAllList.innerHTML = "";
    notesEmpty.style.display = notes.length ? "none" : "block";

    notes.forEach(n => {
      const li = document.createElement("li");
      li.className = "note-item";
      li.tabIndex = 0;
      li.style.cursor = "pointer";

      const t = document.createElement("div");
      t.className = "note-item-title";
      t.textContent = n.text.length > 90 ? n.text.slice(0, 90) + "…" : n.text;

      const s = document.createElement("div");
      s.className = "note-item-sub";
      s.textContent = `${n.bookTitle || "—"} • ${new Date(n.updatedAt || n.createdAt).toLocaleString()}`;

      li.appendChild(t);
      li.appendChild(s);

      li.addEventListener("click", () => selectNote(n.id));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter") selectNote(n.id);
      });

      notesAllList.appendChild(li);
    });

    // If selected note disappeared, clear preview
    if (selectedNoteId && !state.notes.find(n => n.id === selectedNoteId)) {
      selectedNoteId = null;
      clearNotePreview();
    } else if (selectedNoteId) {
      // Keep preview updated
      selectNote(selectedNoteId, true);
    }
  }

  function selectNote(noteId, silent = false) {
    const note = state.notes.find(n => n.id === noteId);
    if (!note) return;
    selectedNoteId = noteId;

    notePreviewBook.textContent = `${note.bookTitle || "—"} • at index ${note.index}`;
    notePreviewText.textContent = note.text;
    noteEdit.value = note.text;

    if (!silent) {
      // Also open the related book and jump to note location
      const book = getBook(note.bookId);
      if (book) {
        openBookInReader(book.id);
        setView("reader");
        stepWords(0); // re-render
        setTokenIndex(note.index, { fromPlayback: false });
        renderReaderNotes();
      }
    }
  }

  function clearNotePreview() {
    notePreviewBook.textContent = "—";
    notePreviewText.textContent = "Select a note to view/edit.";
    noteEdit.value = "";
  }

  /* ---------------------------
     Export / Import
  --------------------------- */
  function exportData() {
    const payload = {
      exportedAt: nowISO(),
      app: "SwiftReader",
      version: state.version,
      state
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `swiftreader-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importData() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await fileToText(file);
      const parsed = safeJsonParse(text, null);
      if (!parsed || typeof parsed !== "object") {
        alert("Invalid JSON file.");
        return;
      }
      const importedState = parsed.state || parsed; // allow raw state
      if (!importedState || typeof importedState !== "object") {
        alert("Import file does not contain a valid state.");
        return;
      }

      // Merge carefully
      const base = defaultState();
      state = {
        ...base,
        ...importedState,
        settings: { ...base.settings, ...(importedState.settings || {}) },
        library: { ...base.library, ...(importedState.library || {}) },
        notes: Array.isArray(importedState.notes) ? importedState.notes : []
      };
      if (!Array.isArray(state.library.books)) state.library.books = [];
      state.library.books = state.library.books.map(b => normalizeBook(b));
      saveState();

      // Refresh UI
      stopReader(true);
      selectedBookId = null;
      selectedNoteId = null;
      applyThemeFromSettings();
      applyReaderStyleSettings();
      hydrateSettingsUI();
      renderAll();
      alert("Import completed.");
    });
    input.click();
  }

  /* ---------------------------
     Render all views
  --------------------------- */
  function renderAll() {
    renderLibraryList();
    renderReader();
    renderReaderNotes();
    renderNotesView();
    updateStorageEstimate();
  }

  /* ---------------------------
     Compatibility: unused buttons in HTML
     (Add Book just opens library import area)
  --------------------------- */
  addBookBtn.addEventListener("click", () => {
    // Focus on import area
    setView("library");
    importTitle.focus();
  });

})();
