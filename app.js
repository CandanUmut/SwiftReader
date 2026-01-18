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
  const APP_VERSION = "2.0.0";
  console.info(`SwiftReader loaded v${APP_VERSION}`);
  const diagnostics = {
    storage: false,
    pdfUpload: false
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const safeQuery = (sel, root = document) => {
    const el = root.querySelector(sel);
    if (!el) {
      console.warn(`SwiftReader: missing element ${sel}`);
    }
    return el;
  };
  const nowISO = () => new Date().toISOString();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const FOCUSABLE_SELECTOR = "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])";

  function bind(el, event, handler, name = event) {
    if (!el) {
      console.warn(`SwiftReader bind: missing ${name}`);
      return false;
    }
    el.addEventListener(event, handler);
    return true;
  }

  function bindWithOptions(el, event, handler, options, name = event) {
    if (!el) {
      console.warn(`SwiftReader bind: missing ${name}`);
      return false;
    }
    el.addEventListener(event, handler, options);
    return true;
  }

  function setButtonLoading(btn, isLoading, label = "Importing…") {
    if (!btn) return;
    if (!btn.dataset.originalLabel) {
      btn.dataset.originalLabel = btn.textContent || "";
    }
    if (isLoading) {
      btn.classList.add("is-loading");
      btn.disabled = true;
      btn.setAttribute("aria-busy", "true");
      btn.textContent = label;
    } else {
      btn.classList.remove("is-loading");
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.textContent = btn.dataset.originalLabel;
    }
  }

  const bootToasts = [];
  let pendingMigrationWrite = null;

  function enqueueBootToast(toast) {
    if (!toast) return;
    bootToasts.push(toast);
  }

  function flushBootToasts() {
    if (!bootToasts.length) return;
    bootToasts.splice(0).forEach(payload => showToast(payload));
  }

  function safeParseJSON(raw, fallback, contextLabel = "data") {
    if (raw === null || raw === undefined || raw === "") return fallback;
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.warn(`SwiftReader: failed to parse ${contextLabel}`, err);
      const toastPayload = {
        title: "Data load issue",
        message: `We couldn't read ${contextLabel}. Loading defaults instead.`,
        type: "error",
        duration: 7000,
        actions: [
          { label: "Export raw storage", handler: () => exportRawStorage() },
          ...(contextLabel === "local storage"
            ? [{ label: "Repair storage", handler: () => repairStorage() }]
            : [])
        ]
      };
      if (globalThis.__swiftreaderToastReady) {
        showToast(toastPayload);
      } else {
        enqueueBootToast(toastPayload);
      }
      return fallback;
    }
  }

  function safeStringifyJSON(obj, contextLabel = "data") {
    try {
      return JSON.stringify(obj);
    } catch (err) {
      console.error(`SwiftReader: failed to serialize ${contextLabel}`, err);
      showToast({
        title: "Data save failed",
        message: "Unable to save changes to storage.",
        type: "error",
        duration: 6000
      });
      return null;
    }
  }

  function summarizeStateShape(payload) {
    const books = payload?.library?.books;
    const notes = payload?.notes;
    return {
      version: payload?.version ?? null,
      booksIsArray: Array.isArray(books),
      booksCount: Array.isArray(books) ? books.length : 0,
      notesIsArray: Array.isArray(notes),
      notesCount: Array.isArray(notes) ? notes.length : 0
    };
  }

  function logStorageDiagnostic(event, payload = {}) {
    if (!diagnostics.storage) return;
    console.info("[SwiftReader][storage]", event, payload);
  }

  function logPdfDiagnostic(event, payload = {}) {
    if (!diagnostics.pdfUpload) return;
    console.info("[SwiftReader][pdf]", event, payload);
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

  function sanitizeExtractedText(raw) {
    if (!raw) return "";
    const cleaned = String(raw).replace(/\u0000/g, "");
    return normalizeText(cleaned);
  }

  function cloneArrayBuffer(buffer) {
    if (!(buffer instanceof ArrayBuffer)) return buffer;
    if (buffer.byteLength === 0) return new ArrayBuffer(0);
    return buffer.slice(0);
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

  async function fileToTextAsync(file) {
    if (file?.text) {
      return file.text();
    }
    return fileToText(file);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = target.tagName ? target.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    if (target.isContentEditable) return true;
    return !!target.closest?.("[contenteditable='true']");
  }

  /* ---------------------------
     Tokenization
     We store tokens as objects:
     { t: "word", kind: "word" }
     { t: ".", kind: "punct" }
     { t: "\n\n", kind: "para" }
  --------------------------- */
  const PUNCT_RE = /^[,.;:!?…]+$/;
  const HARD_PUNCT_RE = /^[.!?…]+$/;
  const SOFT_PUNCT_RE = /^[,;:]+$/;
  const HARD_PUNCT_WORD_RE = /[.!?…]+$/;
  const SOFT_PUNCT_WORD_RE = /[,;:]+$/;
  const LEADING_WRAPPER_RE = /^[([{"'“‘]+/;
  const TRAILING_WRAPPER_RE = /[)\]}"'”’]+$/;
  const WORD_CHAR_RE = (() => {
    try {
      return new RegExp("[\\p{L}\\p{N}]", "u");
    } catch (err) {
      return /[A-Za-z0-9]/;
    }
  })();

  function mergePunctuationTokens(tokens) {
    if (!Array.isArray(tokens) || tokens.length === 0) return { tokens: [], changed: false };
    const merged = [];
    let leading = "";
    let changed = false;

    const appendToPreviousWord = (text) => {
      const last = merged[merged.length - 1];
      if (last && last.kind === "word") {
        last.t += text;
        return;
      }
      leading += text;
    };

    tokens.forEach(tok => {
      if (!tok) return;
      if (tok.kind === "para") {
        if (leading) {
          changed = true;
          leading = "";
        }
        merged.push({ ...tok });
        return;
      }

      if (tok.kind === "punct") {
        changed = true;
        appendToPreviousWord(tok.t || "");
        return;
      }

      if (tok.kind === "word") {
        const text = `${leading}${tok.t || ""}`;
        if (text) merged.push({ ...tok, t: text, kind: "word" });
        if (leading) changed = true;
        leading = "";
      }
    });

    return { tokens: merged, changed };
  }

  function getWordIndexForTokenIndexFromTokens(tokens, tokenIndex) {
    if (!Array.isArray(tokens) || !tokens.length) return 0;
    let idx = clamp(tokenIndex, 0, tokens.length - 1);
    let wordIndex = 0;
    for (let i = 0; i <= idx; i += 1) {
      if (tokens[i]?.kind === "word") wordIndex += 1;
    }
    if (tokens[idx]?.kind === "word") return Math.max(0, wordIndex - 1);
    return Math.max(0, wordIndex - 1);
  }

  function getTokenIndexForWordIndexFromTokens(tokens, wordIndex) {
    if (!Array.isArray(tokens) || !tokens.length) return 0;
    let count = 0;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i]?.kind === "word") {
        if (count === wordIndex) return i;
        count += 1;
      }
    }
    return Math.max(0, tokens.length - 1);
  }

  function tokenize(text) {
    const t = normalizeText(text);
    if (!t) return [];

    // Preserve paragraph breaks
    const parts = t.split(/\n{2,}/g);
    const tokens = [];

    for (let p = 0; p < parts.length; p++) {
      const para = parts[p].trim();
      if (!para) continue;

      const raw = para
        .split(/\s+/g)
        .map(token => token.trim())
        .filter(Boolean);

      for (const r of raw) {
        const isWordLike = WORD_CHAR_RE.test(r);
        if (!isWordLike) {
          tokens.push({ t: r, kind: "punct" });
        } else {
          tokens.push({ t: r, kind: "word" });
        }
      }

      // Paragraph break (except after last)
      if (p < parts.length - 1) {
        tokens.push({ t: "\n\n", kind: "para" });
      }
    }

    return mergePunctuationTokens(tokens).tokens;
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
     IndexedDB (idb)
  --------------------------- */
  const DB_NAME = "swiftreader_v2";
  const DB_VERSION = 1;
  const DB_STORES = {
    books: "books",
    contents: "contents",
    notes: "notes",
    settings: "settings"
  };

  let dbPromise = null;
  let idbReady = false;

  function getDb() {
    if (!window.idb || !window.idb.openDB) {
      return null;
    }
    if (!dbPromise) {
      dbPromise = window.idb.openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(DB_STORES.books)) {
            db.createObjectStore(DB_STORES.books, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(DB_STORES.contents)) {
            db.createObjectStore(DB_STORES.contents, { keyPath: "bookId" });
          }
          if (!db.objectStoreNames.contains(DB_STORES.notes)) {
            db.createObjectStore(DB_STORES.notes, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(DB_STORES.settings)) {
            db.createObjectStore(DB_STORES.settings, { keyPath: "key" });
          }
        }
      });
    }
    return dbPromise;
  }

  async function initIndexedDb() {
    const db = getDb();
    if (!db) return false;
    try {
      await db;
      idbReady = true;
      return true;
    } catch (err) {
      console.warn("IndexedDB unavailable", err);
      idbReady = false;
      return false;
    }
  }

  async function idbGet(storeName, key) {
    const db = getDb();
    if (!db) return null;
    return (await db).get(storeName, key);
  }

  async function idbGetAll(storeName) {
    const db = getDb();
    if (!db) return [];
    return (await db).getAll(storeName);
  }

  async function idbPut(storeName, value) {
    const db = getDb();
    if (!db) return;
    return (await db).put(storeName, value);
  }

  async function idbDelete(storeName, key) {
    const db = getDb();
    if (!db) return;
    return (await db).delete(storeName, key);
  }

  async function idbClear(storeName) {
    const db = getDb();
    if (!db) return;
    return (await db).clear(storeName);
  }

  const contentCache = new Map();
  const wordIndexCache = new Map();
  const pageMapCache = new Map();

  /* ---------------------------
     Storage Model
     State is stored in localStorage key:
     swiftreader_v1
  --------------------------- */
  const STORE_KEY = "swiftreader_v1";

  const CURRENT_SCHEMA_VERSION = 5;

  const defaultState = () => ({
    version: CURRENT_SCHEMA_VERSION,
    createdAt: nowISO(),
    updatedAt: Date.now(),
    lastOpenedBookId: null,
    settings: {
      theme: "system", // "system" | "dark" | "light"
      defaultWpm: 300,
      fontSize: 46,
      fontFamily: "system", // system | serif | mono
      autoPause: true,
      tapControls: true,
      rememberLastBook: true,
      punctuationPause: 80, // 0-200 slider value
      chunkSize: 1,
      wakeLock: false,
      readerMode: null,
      autoRemoveHeadersFooters: true,
      customIgnorePhrases: ""
    },
    reader: {
      currentBookId: null
    },
    library: {
      books: [], // Book[]
      lastOpenedBookId: null,
    },
    notes: [], // Note[]
    storage: {
      migratedToIdb: false,
      migratedAt: null
    }
  });

  // Book shape:
  // {
  //   id, title, author, tags:[], addedAt, updatedAt,
  //   sourceType:"paste"|"txt"|"md"|"epub"|"pdf",
  //   text, tokens, wordCount, tokenCount, contentStored,
  //   progress: { index:number, updatedAt, bookmarks: [{id, index, createdAt}] },
  //   readerState: { currentWordIndex, currentPdfPage, wpm, pause, syncRsvpToPage },
  //   stats: { openedAt, lastSessionAt, totalReadWords }
  // }
  //
  // Note shape:
  // { id, bookId, bookTitle, index, excerpt, text, createdAt, updatedAt }

  let state = loadState();

  function inferVersion(rawState) {
    if (rawState && typeof rawState.version === "number") return rawState.version;
    if (rawState?.library?.books || rawState?.reader) return 2;
    if (Array.isArray(rawState?.books) || Array.isArray(rawState?.notes)) return 1;
    return 0;
  }

  function normalizeSettings(settings) {
    const base = defaultState().settings;
    return {
      ...base,
      ...(settings || {}),
      defaultWpm: Number(settings?.defaultWpm ?? base.defaultWpm) || base.defaultWpm,
      fontSize: Number(settings?.fontSize ?? base.fontSize) || base.fontSize,
      punctuationPause: typeof settings?.punctuationPause === "number" ? settings.punctuationPause : base.punctuationPause,
      chunkSize: Number(settings?.chunkSize ?? base.chunkSize) || base.chunkSize,
      autoPause: settings?.autoPause !== undefined ? !!settings.autoPause : base.autoPause,
      tapControls: settings?.tapControls !== undefined ? !!settings.tapControls : base.tapControls,
      rememberLastBook: settings?.rememberLastBook !== undefined ? !!settings.rememberLastBook : base.rememberLastBook,
      wakeLock: settings?.wakeLock !== undefined ? !!settings.wakeLock : base.wakeLock,
      autoRemoveHeadersFooters: settings?.autoRemoveHeadersFooters !== undefined
        ? !!settings.autoRemoveHeadersFooters
        : base.autoRemoveHeadersFooters,
      customIgnorePhrases: typeof settings?.customIgnorePhrases === "string" ? settings.customIgnorePhrases : base.customIgnorePhrases
    };
  }

  function normalizeNote(note) {
    return {
      id: note?.id || uid("note"),
      bookId: note?.bookId || "",
      bookTitle: note?.bookTitle || "",
      index: typeof note?.index === "number" ? note.index : (note?.wordIndex ?? 0),
      wordIndex: typeof note?.wordIndex === "number" ? note.wordIndex : (note?.index ?? 0),
      excerpt: note?.excerpt || "",
      text: (note?.text || "").trim(),
      createdAt: note?.createdAt || nowISO(),
      updatedAt: note?.updatedAt || nowISO()
    };
  }

  function migrateState(rawState) {
    try {
      const base = defaultState();
      const inferredVersion = inferVersion(rawState);
      const source = rawState?.state && typeof rawState.state === "object" ? rawState.state : rawState;
      const books = Array.isArray(source?.books)
        ? source.books
        : Array.isArray(source?.library?.books)
          ? source.library.books
          : [];
      const notes = Array.isArray(source?.notes) ? source.notes : [];
      const settings = normalizeSettings(source?.settings || source?.state?.settings);
      const reader = source?.reader || source?.state?.reader || {};
      const lastOpenedBookId = source?.lastOpenedBookId ?? source?.library?.lastOpenedBookId ?? null;

      const normalizedBooks = books
        .map(b => (b && typeof b === "object" ? normalizeBook(b) : null))
        .filter(Boolean);

      const migrated = {
        ...base,
        ...source,
        version: CURRENT_SCHEMA_VERSION,
        updatedAt: Date.now(),
        lastOpenedBookId,
        settings,
        reader: { ...base.reader, ...(reader || {}) },
        library: {
          ...base.library,
          ...(source?.library || {}),
          books: normalizedBooks,
          lastOpenedBookId
        },
        notes: notes.map(n => normalizeNote(n)),
        storage: { ...base.storage, ...(source?.storage || {}) }
      };

      if (!Array.isArray(migrated.library.books)) migrated.library.books = [];
      if (!Array.isArray(migrated.notes)) migrated.notes = [];

      if (inferredVersion !== CURRENT_SCHEMA_VERSION) {
        pendingMigrationWrite = migrated;
      }

      return migrated;
    } catch (err) {
      console.warn("SwiftReader migration failed", err);
      enqueueBootToast({
        title: "Migration issue",
        message: "We couldn't fully migrate stored data. Some items may be missing.",
        type: "warning",
        duration: 7000,
        actions: [
          { label: "Export raw storage", handler: () => exportRawStorage() }
        ]
      });
      return defaultState();
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      logStorageDiagnostic("READ", {
        key: STORE_KEY,
        length: raw ? raw.length : 0
      });
      if (!raw) return defaultState();
      const parsed = safeParseJSON(raw, null, "local storage");
      if (!parsed || typeof parsed !== "object") return defaultState();
      const migrated = migrateState(parsed);
      logStorageDiagnostic("READ_OK", summarizeStateShape(migrated));
      return migrated;
    } catch (err) {
      console.warn("SwiftReader loadState failed", err);
      showToast({
        title: "Data load failed",
        message: "SwiftReader couldn't read storage. Loading defaults instead.",
        type: "error",
        duration: 7000
      });
      return defaultState();
    }
  }

  function serializeStateForStorage() {
    if (!state.storage?.migratedToIdb) return state;
    const strippedBooks = state.library.books.map(book => ({
      ...book,
      text: "",
      tokens: []
    }));
    return {
      ...state,
      library: {
        ...state.library,
        books: strippedBooks
      }
    };
  }

  function saveState() {
    try {
      state.updatedAt = Date.now();
      if (!Array.isArray(state.library?.books)) state.library.books = [];
      if (!Array.isArray(state.notes)) state.notes = [];
      const toStore = serializeStateForStorage();
      const serialized = safeStringifyJSON(toStore, "local storage");
      if (!serialized) return;
      logStorageDiagnostic("WRITE", {
        key: STORE_KEY,
        length: serialized.length,
        summary: summarizeStateShape(toStore)
      });
      try {
        localStorage.setItem(STORE_KEY, serialized);
      } catch (err) {
        console.error("SwiftReader storage write failed", err);
        showToast({
          title: "Data save failed",
          message: "Unable to write to local storage. Your previous data is unchanged.",
          type: "error",
          duration: 7000
        });
        return;
      }
      updateStorageEstimate();
      void persistSettingsToIdb();
    } catch (err) {
      console.error("SwiftReader saveState failed", err);
      showToast({
        title: "Data save failed",
        message: "Unexpected error while saving.",
        type: "error",
        duration: 7000
      });
    }
  }

  function exportRawStorage() {
    const raw = localStorage.getItem(STORE_KEY) || "";
    const payload = {
      exportedAt: nowISO(),
      app: "SwiftReader",
      storeKey: STORE_KEY,
      raw
    };
    const serialized = safeStringifyJSON(payload, "raw storage");
    if (!serialized) return;
    const blob = new Blob([serialized], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `swiftreader-raw-storage-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function repairStorage() {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) {
      showToast({ title: "No storage data", message: "Nothing to repair yet.", type: "info" });
      return false;
    }
    const parsed = safeParseJSON(raw, null, "local storage");
    if (!parsed || typeof parsed !== "object") {
      showToast({
        title: "Repair failed",
        message: "Storage data could not be parsed. Export raw data for backup.",
        type: "error",
        duration: 7000
      });
      return false;
    }
    const migrated = migrateState(parsed);
    const serialized = safeStringifyJSON(migrated, "repaired storage");
    if (!serialized) return false;
    try {
      localStorage.setItem(STORE_KEY, serialized);
    } catch (err) {
      console.error("SwiftReader repair write failed", err);
      showToast({
        title: "Repair failed",
        message: "Unable to write repaired data to storage.",
        type: "error",
        duration: 7000
      });
      return false;
    }
    state = migrateState(migrated);
    renderAll();
    showToast({ title: "Storage repaired", message: "Recovered data has been re-saved.", type: "success" });
    return true;
  }

  function normalizeBook(b) {
    const nb = {
      id: b?.id || uid("book"),
      title: (b?.title || "Untitled").trim() || "Untitled",
      author: (b?.author || "").trim(),
      tags: Array.isArray(b?.tags) ? b.tags : (typeof b?.tags === "string" ? b.tags.split(",").map(tag => tag.trim()).filter(Boolean) : []),
      addedAt: b?.addedAt || nowISO(),
      updatedAt: b?.updatedAt || nowISO(),
      sourceType: b?.sourceType || b?.type || "paste",
      type: b?.type || b?.sourceType || "paste",
      source: {
        filename: b?.source?.filename || b?.filename || "",
        fileType: b?.source?.fileType || b?.fileType || "",
        size: typeof b?.source?.size === "number" ? b.source.size : (typeof b?.size === "number" ? b.size : null)
      },
      text: typeof b?.text === "string" ? b.text : "",
      tokens: Array.isArray(b?.tokens) ? b.tokens : [],
      wordCount: typeof b?.wordCount === "number" ? b.wordCount : 0,
      tokenCount: typeof b?.tokenCount === "number" ? b.tokenCount : (Array.isArray(b?.tokens) ? b.tokens.length : 0),
      contentStored: b?.contentStored || (b?.text ? "local" : "idb"),
      progress: {
        index: typeof b?.progress?.index === "number" ? b.progress.index : 0,
        wordIndex: typeof b?.progress?.wordIndex === "number" ? b.progress.wordIndex : (b?.progress?.index ?? 0),
        percent: typeof b?.progress?.percent === "number" ? b.progress.percent : 0,
        pdfPage: typeof b?.progress?.pdfPage === "number" ? b.progress.pdfPage : null,
        updatedAt: b?.progress?.updatedAt || nowISO(),
        bookmarks: Array.isArray(b?.progress?.bookmarks) ? b.progress.bookmarks : []
      },
      readerState: {
        currentWordIndex: typeof b?.readerState?.currentWordIndex === "number" ? b.readerState.currentWordIndex : 0,
        currentPdfPage: typeof b?.readerState?.currentPdfPage === "number" ? b.readerState.currentPdfPage : 1,
        wpm: typeof b?.readerState?.wpm === "number" ? b.readerState.wpm : 300,
        pause: typeof b?.readerState?.pause === "number" ? b.readerState.pause : 80,
        syncRsvpToPage: !!b?.readerState?.syncRsvpToPage
      },
      stats: {
        openedAt: b?.stats?.openedAt || null,
        lastSessionAt: b?.stats?.lastSessionAt || null,
        totalReadWords: typeof b?.stats?.totalReadWords === "number" ? b.stats.totalReadWords : 0
      }
    };

    // If tokens missing but text exists, generate tokens on load (legacy data)
    if ((!nb.tokens || nb.tokens.length === 0) && nb.text) {
      nb.tokens = tokenize(nb.text);
      nb.wordCount = countWords(nb.tokens);
      nb.tokenCount = nb.tokens.length;
    }

    // Clamp progress
    const totalTokens = Math.max(0, nb.tokenCount || nb.tokens.length || 0);
    nb.progress.index = clamp(nb.progress.index, 0, Math.max(0, totalTokens - 1));
    nb.readerState.currentWordIndex = Math.max(0, nb.readerState.currentWordIndex || 0);
    nb.readerState.currentPdfPage = Math.max(1, nb.readerState.currentPdfPage || 1);
    return nb;
  }

  function upsertBook(book) {
    const idx = state.library.books.findIndex(b => b.id === book.id);
    if (idx >= 0) state.library.books[idx] = normalizeBook(book);
    else state.library.books.unshift(normalizeBook(book));
    saveState();
    void persistBookMetadataToIdb(book.id);
  }

  function deleteBook(bookId) {
    state.library.books = state.library.books.filter(b => b.id !== bookId);
    // Remove notes for that book
    state.notes = state.notes.filter(n => n.bookId !== bookId);
    if (state.library.lastOpenedBookId === bookId) state.library.lastOpenedBookId = null;
    if (state.lastOpenedBookId === bookId) state.lastOpenedBookId = null;
    saveState();
    void deleteBookFromIdb(bookId);
  }

  function getBook(bookId) {
    return state.library.books.find(b => b.id === bookId) || null;
  }

  function updateBookReaderState(bookId, changes) {
    const book = getBook(bookId);
    if (!book) return null;
    const updated = {
      ...book,
      readerState: {
        ...book.readerState,
        ...changes
      }
    };
    upsertBook(updated);
    return updated;
  }

  function upsertNote(note) {
    const idx = state.notes.findIndex(n => n.id === note.id);
    const normalized = {
      id: note.id || uid("note"),
      bookId: note.bookId,
      bookTitle: note.bookTitle || "",
      index: typeof note.index === "number" ? note.index : (note.wordIndex ?? 0),
      wordIndex: typeof note.wordIndex === "number" ? note.wordIndex : (note.index ?? 0),
      excerpt: note.excerpt || "",
      text: (note.text || "").trim(),
      createdAt: note.createdAt || nowISO(),
      updatedAt: nowISO()
    };
    if (idx >= 0) state.notes[idx] = normalized;
    else state.notes.unshift(normalized);
    saveState();
    void idbPut(DB_STORES.notes, normalized);
    return normalized;
  }

  /* ---------------------------
     IndexedDB sync helpers
  --------------------------- */
  async function persistBookMetadataToIdb(bookId) {
    if (!idbReady) return;
    const book = getBook(bookId);
    if (!book) return;
    const normalized = normalizeBook(book);
    const payload = {
      ...normalized,
      text: "",
      tokens: []
    };
    await idbPut(DB_STORES.books, payload);
  }

  async function persistBookContentToIdb(bookId, rawText, tokens, extra = {}) {
    if (!idbReady) return;
    wordIndexCache.delete(bookId);
    pageMapCache.delete(bookId);
    const safeExtras = {
      ...extra,
      fileData: extra?.fileData instanceof ArrayBuffer ? cloneArrayBuffer(extra.fileData) : extra?.fileData
    };
    const payload = {
      bookId,
      rawText: rawText || "",
      tokens: Array.isArray(tokens) ? tokens : [],
      tokenCount: Array.isArray(tokens) ? tokens.length : 0,
      updatedAt: nowISO(),
      ...safeExtras
    };
    await idbPut(DB_STORES.contents, payload);
    contentCache.set(bookId, payload);
  }

  async function deleteBookFromIdb(bookId) {
    if (!idbReady) return;
    await idbDelete(DB_STORES.books, bookId);
    await idbDelete(DB_STORES.contents, bookId);
    contentCache.delete(bookId);
    wordIndexCache.delete(bookId);
    pageMapCache.delete(bookId);
    const notes = await idbGetAll(DB_STORES.notes);
    const toDelete = notes.filter(n => n.bookId === bookId);
    await Promise.all(toDelete.map(n => idbDelete(DB_STORES.notes, n.id)));
  }

  async function persistSettingsToIdb() {
    if (!idbReady) return;
    await idbPut(DB_STORES.settings, { key: "settings", value: state.settings });
  }

  async function hydrateNotesFromIdb() {
    if (!idbReady) return;
    const notes = await idbGetAll(DB_STORES.notes);
    if (notes.length) {
      state.notes = notes;
      saveState();
    }
  }

  async function hydrateBooksFromIdb() {
    if (!idbReady) return;
    const books = await idbGetAll(DB_STORES.books);
    if (books.length) {
      state.library.books = books.map(b => normalizeBook(b));
      saveState();
    }
  }

  async function migrateLocalStorageToIdb() {
    if (!idbReady) return;
    if (state.storage?.migratedToIdb) return;

    const booksToMigrate = state.library.books.filter(b => (b.text && b.text.length) || (b.tokens && b.tokens.length));
    const notesToMigrate = Array.isArray(state.notes) ? state.notes : [];

    try {
      for (const book of state.library.books) {
        await idbPut(DB_STORES.books, {
          ...book,
          text: "",
          tokens: []
        });
      }
      for (const book of booksToMigrate) {
        const text = book.text || "";
        const tokens = Array.isArray(book.tokens) && book.tokens.length ? book.tokens : tokenize(text);
        await persistBookContentToIdb(book.id, text, tokens);
      }
      for (const note of notesToMigrate) {
        await idbPut(DB_STORES.notes, note);
      }
      await persistSettingsToIdb();
      state.storage.migratedToIdb = true;
      state.storage.migratedAt = nowISO();
      saveState();
    } catch (err) {
      console.warn("Migration to IndexedDB failed", err);
    }
  }

  async function resetIndexedDb() {
    if (!idbReady) return;
    await Promise.all([
      idbClear(DB_STORES.books),
      idbClear(DB_STORES.contents),
      idbClear(DB_STORES.notes),
      idbClear(DB_STORES.settings)
    ]);
    contentCache.clear();
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
  const importStatus = $("#import-status");

  const pasteText = $("#paste-text");
  const pasteTitle = $("#paste-title");
  const pasteAddBtn = $("#paste-add-btn");
  const pasteClearBtn = $("#paste-clear-btn");
  const pasteStatus = $("#paste-status");

  const librarySearch = $("#library-search");
  const librarySort = $("#library-sort");
  const bookList = $("#book-list");
  const libraryEmpty = $("#library-empty");
  const storageEstimate = $("#storage-estimate");
  const dangerResetBtn = $("#danger-reset-btn");
  const emptyDemoBtn = $("#empty-demo-btn");
  const emptyPasteBtn = $("#empty-paste-btn");
  const emptyHelpBtn = $("#empty-help-btn");

  const exportBtn = $("#export-btn");
  const importDataBtn = $("#import-data-btn");
  const repairStorageBtn = $("#repair-storage-btn");

  // Reader view elements
  const openLibraryBtn = $("#open-library-btn");
  const readerBookTitle = $("#reader-book-title");
  const readerBookSub = $("#reader-book-sub");
  const wpmValue = $("#wpm-value");
  const readerProgressEl = $("#reader-progress");
  const pageView = $("#page-view");
  const pageProgress = $("#page-progress");
  const progressSlider = $("#progress-slider");
  const progressLabel = $("#progress-label");
  const documentViewer = $("#document-viewer");
  const viewerStatus = $("#viewer-status");
  const pdfViewer = $("#pdf-viewer");
  const pdfCanvasWrap = $("#pdf-canvas-wrap");
  const pdfCanvas = $("#pdf-canvas");
  const pdfFirstBtn = $("#pdf-first-btn");
  const pdfPrevBtn = $("#pdf-prev-btn");
  const pdfNextBtn = $("#pdf-next-btn");
  const pdfLastBtn = $("#pdf-last-btn");
  const pdfPageInput = $("#pdf-page-input");
  const pdfPageTotal = $("#pdf-page-total");
  const pdfGoBtn = $("#pdf-go-btn");
  const pdfPageSlider = $("#pdf-page-slider");
  const pdfFullscreenBtn = $("#pdf-fullscreen-btn");
  const pdfFitWidthBtn = $("#pdf-fit-width");
  const pdfFitPageBtn = $("#pdf-fit-page");
  const pdfZoomResetBtn = $("#pdf-zoom-reset");
  const pdfZoomInBtn = $("#pdf-zoom-in");
  const pdfZoomOutBtn = $("#pdf-zoom-out");
  const pdfZoomLabel = $("#pdf-zoom-label");
  const syncRsvpToggle = $("#sync-rsvp-toggle");
  const epubViewer = $("#epub-viewer");
  const viewerControls = $(".viewer-controls");
  const pdfFullscreenTarget = document.querySelector(".reader-page");

  const rsvpLeft = $("#rsvp-left");
  const rsvpPivot = $("#rsvp-pivot");
  const rsvpRight = $("#rsvp-right");
  const rsvpSubline = $("#rsvp-subline");
  const rsvpFrame = $(".rsvp-frame");

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
  const bookmarkList = $("#bookmark-list");
  const bookmarkEmpty = $("#bookmark-empty");

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
  const chunkSizeSelect = $("#chunk-size");
  const autoPauseCheckbox = $("#auto-pause");
  const tapControlsCheckbox = $("#tap-controls");
  const wakeLockCheckbox = $("#wake-lock");
  const rememberLastBookCheckbox = $("#remember-last-book");
  const autoRemoveHeadersCheckbox = $("#auto-remove-headers");
  const customIgnorePhrasesInput = $("#custom-ignore-phrases");
  const encryptExportCheckbox = $("#encrypt-export"); // stub

  const settingsExportBtn = $("#settings-export-btn");
  const settingsImportBtn = $("#settings-import-btn");
  const settingsResetBtn = $("#settings-reset-btn");

  // Modals and toast
  const modalConfirm = $("#modal-confirm");
  const confirmTitle = $("#confirm-title");
  const confirmMessage = $("#confirm-message");
  const confirmOkBtn = $("#confirm-ok-btn");
  const confirmCancelBtn = $("#confirm-cancel-btn");
  const toastRegion = $("#toast-region");

  // Footer buttons (optional)
  const aboutBtn = $("#about-btn");
  const shortcutsBtn = $("#shortcuts-btn");

  /* ---------------------------
     UI State
  --------------------------- */
  let currentView = "library";
  let selectedBookId = null;
  let activeModal = null;
  let lastFocusedEl = null;
  let confirmResolver = null;
  let scrollLocked = false;
  let scrollLockY = 0;
  let wakeLockHandle = null;
  let pageViewBookId = null;
  let scrubberActive = false;
  let scrubberRaf = null;
  let pendingScrubValue = null;
  let pdfSyncTimer = null;
  let pdfSyncTarget = null;
  let pdfScrubTimer = null;
  let fatalBanner = null;
  let bootBindings = { attempted: 0, bound: 0 };

  const pdfState = {
    doc: null,
    page: 1,
    total: 1,
    fitScale: 1,
    renderScale: 1,
    canvasWidth: 0,
    canvasHeight: 0,
    scale: 1,
    fitMode: "width",
    rendering: false,
    queuedPage: null,
    currentBookId: null,
    isFullscreen: false,
    isPseudoFullscreen: false,
    pendingScroll: null,
    pointers: new Map(),
    pinchState: null,
    panState: null,
    renderDebounce: null
  };

  const epubState = {
    book: null,
    rendition: null,
    currentBookId: null
  };

  // Reader session runtime
  const reader = {
    isPlaying: false,
    timer: null,
    startedAt: null,          // timestamp ms for session
    elapsedBefore: 0,         // ms accumulated before last play
    sessionWords: 0,          // word tokens shown during session
    pauses: 0,                // number of manual pauses
    lastTickAt: null,
    nextTickAt: null,
    chunkDisplay: null
  };

  // Selected note in Notes view
  let selectedNoteId = null;

  // Import buffer for file panel
  let importBuffer = {
    files: [],
    items: [],
    text: "",
    sourceType: null,
    suggestedTitle: ""
  };

  /* ---------------------------
     Init
  --------------------------- */
  void (async () => {
    try {
      initGlobalErrorHandlers();
      await initApp();
    } catch (err) {
      console.error("SwiftReader boot error", err);
      showFatalBanner("App failed to start. Open console for details.");
      showToast({
        title: "SwiftReader failed to start",
        message: err instanceof Error ? err.message : "Unexpected error during startup.",
        type: "error",
        duration: 7000
      });
    }
  })();

  async function initApp() {
    await initIndexedDb();
    await migrateLocalStorageToIdb();
    await hydrateBooksFromIdb();
    await hydrateNotesFromIdb();
    if (pendingMigrationWrite) {
      pendingMigrationWrite = null;
      saveState();
    }
    globalThis.__swiftreaderToastReady = true;
    applyThemeFromSettings();
    applyReaderStyleSettings();
    hydrateSettingsUI();
    initReaderMode();
    runSmokeChecks();
    initDebugHelpers();
    flushBootToasts();
    bootBindings = wireEvents();
    updatePdfFullscreenButton();
    logBootStatus();
    renderAll();
    restoreLastBookIfNeeded();
    registerServiceWorker();
  }

  /* ---------------------------
     Event Wiring
  --------------------------- */
  function wireEvents() {
    const bindings = { attempted: 0, bound: 0 };
    const on = (el, event, handler, name) => {
      bindings.attempted += 1;
      if (bind(el, event, handler, name)) bindings.bound += 1;
    };

    // Theme toggle cycles: system -> dark -> light -> system
    on(themeToggleBtn, "click", () => {
      const cur = state.settings.theme || "system";
      const next = cur === "system" ? "dark" : cur === "dark" ? "light" : "system";
      state.settings.theme = next;
      saveState();
      applyThemeFromSettings();
    }, "#theme-toggle");

    // Help modal
    on(helpBtn, "click", () => openModal(modalHelp, helpBtn), "#help-btn");
    on(modalHelp, "click", (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.close === "true") closeModal(modalHelp);
    }, "#modal-help");

    on(modalConfirm, "click", (e) => {
      const t = e.target;
      if (t && t.dataset && t.dataset.close === "true") resolveConfirm(false);
    }, "#modal-confirm");

    on(confirmOkBtn, "click", () => resolveConfirm(true), "#confirm-ok-btn");
    on(confirmCancelBtn, "click", () => resolveConfirm(false), "#confirm-cancel-btn");

    // Nav
    navButtons.forEach(btn => {
      on(btn, "click", () => {
        const view = btn.dataset.view;
        if (!view) return;
        setView(view);
      }, `nav:${btn.id || btn.dataset.view || "item"}`);
    });

    on(pageView, "click", (event) => {
      if (!selectedBookId) return;
      const book = getBook(selectedBookId);
      if (!book) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const target = event.target;
      const paragraph = target?.closest ? target.closest("p") : null;
      if (!paragraph) return;
      const paraIndex = Number(paragraph.dataset.index || 0);
      const paragraphs = buildPageMap(book.id);
      const para = paragraphs[paraIndex];
      if (!para || !para.wordOffsets.length) return;

      let offset = Math.floor(para.text.length / 2);
      if (selection && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        if (range && paragraph.contains(range.startContainer)) {
          const preRange = range.cloneRange();
          preRange.selectNodeContents(paragraph);
          preRange.setEnd(range.startContainer, range.startOffset);
          offset = preRange.toString().length;
        }
      }

      const nearest = para.wordOffsets.reduce((closest, entry) => {
        if (!closest) return entry;
        const closestMid = (closest.start + closest.end) / 2;
        const entryMid = (entry.start + entry.end) / 2;
        return Math.abs(entryMid - offset) < Math.abs(closestMid - offset) ? entry : closest;
      }, null);

      if (!nearest) return;
      if (reader.isPlaying) stopReader(false);
      setTokenIndex(nearest.tokenIndex, { fromPlayback: false, syncPageView: false });
      if (isNarrowReaderLayout()) setReaderMode("rsvp");
    }, "#page-view");

    on(pdfCanvas, "click", () => {
      if (!selectedBookId) return;
      const book = getBook(selectedBookId);
      if (!book || book.sourceType !== "pdf") return;
      const content = contentCache.get(book.id);
      const pageRanges = content?.pageRanges;
      if (!Array.isArray(pageRanges) || !pageRanges.length) return;
      const currentPage = pdfState.page || 1;
      const range = pageRanges.find(r => r.page === currentPage);
      if (!range || typeof range.start !== "number") return;
      if (reader.isPlaying) stopReader(false);
      const tokenIndex = getTokenIndexForWordIndex(book.id, range.start);
      setTokenIndex(tokenIndex, { fromPlayback: false, syncPageView: false });
      if (isNarrowReaderLayout()) setReaderMode("rsvp");
    }, "#pdf-canvas");

    on(pdfFullscreenBtn, "click", () => togglePdfFullscreen(), "#pdf-fullscreen-btn");

    on(pdfViewer, "pointerdown", handlePdfPointerDown, "#pdf-viewer");
    on(pdfViewer, "pointermove", handlePdfPointerMove, "#pdf-viewer");
    on(pdfViewer, "pointerup", handlePdfPointerUp, "#pdf-viewer");
    on(pdfViewer, "pointercancel", handlePdfPointerUp, "#pdf-viewer");
    on(pdfViewer, "pointerleave", handlePdfPointerUp, "#pdf-viewer");
    if (bindWithOptions(pdfViewer, "wheel", handlePdfWheel, { passive: false }, "#pdf-viewer wheel")) {
      bindings.attempted += 1;
      bindings.bound += 1;
    } else {
      bindings.attempted += 1;
    }

    on(pdfFirstBtn, "click", () => setPdfPage(1, { userInitiated: true }), "#pdf-first-btn");
    on(pdfPrevBtn, "click", () => jumpPdfPage(-1), "#pdf-prev-btn");
    on(pdfNextBtn, "click", () => jumpPdfPage(1), "#pdf-next-btn");
    on(pdfLastBtn, "click", () => setPdfPage(pdfState.total || 1, { userInitiated: true }), "#pdf-last-btn");
    on(pdfFitWidthBtn, "click", () => setPdfFitMode("width"), "#pdf-fit-width");
    on(pdfFitPageBtn, "click", () => setPdfFitMode("page"), "#pdf-fit-page");
    on(pdfZoomResetBtn, "click", () => resetPdfZoom(), "#pdf-zoom-reset");
    on(pdfZoomInBtn, "click", () => adjustPdfZoom(0.1), "#pdf-zoom-in");
    on(pdfZoomOutBtn, "click", () => adjustPdfZoom(-0.1), "#pdf-zoom-out");
    const applyPdfPageInput = () => {
      if (!pdfPageInput) return;
      const value = Number(pdfPageInput.value);
      if (!Number.isFinite(value)) {
        updatePdfControls();
        return;
      }
      setPdfPage(value, { userInitiated: true });
    };
    on(pdfPageInput, "change", () => applyPdfPageInput(), "#pdf-page-input");
    on(pdfPageInput, "keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyPdfPageInput();
      pdfPageInput.blur();
    }, "#pdf-page-input");
    on(pdfPageInput, "blur", () => applyPdfPageInput(), "#pdf-page-input");
    on(pdfGoBtn, "click", () => applyPdfPageInput(), "#pdf-go-btn");
    on(pdfPageSlider, "input", () => {
      if (!pdfPageSlider) return;
      const value = Number(pdfPageSlider.value);
      if (!Number.isFinite(value)) return;
      if (pdfPageInput) pdfPageInput.value = String(value);
      if (pdfScrubTimer) clearTimeout(pdfScrubTimer);
      pdfScrubTimer = setTimeout(() => {
        pdfScrubTimer = null;
        setPdfPage(value, { userInitiated: true });
      }, 120);
    }, "#pdf-page-slider");
    on(pdfPageSlider, "change", () => {
      if (!pdfPageSlider) return;
      const value = Number(pdfPageSlider.value);
      if (!Number.isFinite(value)) return;
      if (pdfScrubTimer) {
        clearTimeout(pdfScrubTimer);
        pdfScrubTimer = null;
      }
      setPdfPage(value, { userInitiated: true });
    }, "#pdf-page-slider");

    on(syncRsvpToggle, "change", () => {
      const book = selectedBookId ? getBook(selectedBookId) : null;
      if (!book) return;
      const updated = {
        ...book,
        readerState: {
          ...book.readerState,
          syncRsvpToPage: !!syncRsvpToggle.checked
        }
      };
      upsertBook(updated);
      if (syncRsvpToggle.checked) {
        const wordIndex = getWordIndexForTokenIndex(book.id, getCurrentTokenIndex());
        syncRsvpToPdfPage(pdfState.page, { wordIndex, userInitiated: false });
      }
    }, "#sync-rsvp-toggle");

    on(openLibraryBtn, "click", () => setView("library"), "#open-library-btn");

    // Import tabs
    on(tabFile, "click", () => setImportTab("file"), "#tab-file");
    on(tabPaste, "click", () => setImportTab("paste"), "#tab-paste");

    // File drop zone
    on(fileDrop, "click", (e) => {
      const target = e.target;
      if (target?.closest?.("label[for='file-input']")) return;
      fileInput?.click();
    }, "#file-drop");
    on(fileDrop, "keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") fileInput?.click();
    }, "#file-drop");

    // Drag & drop
    ["dragenter", "dragover"].forEach(type => {
      on(fileDrop, type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (fileDrop) fileDrop.style.borderColor = "color-mix(in srgb, var(--primary) 40%, var(--border))";
      }, "#file-drop");
    });
    ["dragleave", "drop"].forEach(type => {
      on(fileDrop, type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (fileDrop) fileDrop.style.borderColor = "";
      }, "#file-drop");
    });
    on(fileDrop, "drop", async (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length === 0) return;
      showToast({ title: "Reading files", message: "Starting import…", type: "info" });
      await handleFilesSelected(files);
    }, "#file-drop");

    on(fileInput, "change", async () => {
      const files = Array.from(fileInput.files || []);
      if (files.length === 0) return;
      showToast({ title: "Reading files", message: "Starting import…", type: "info" });
      await handleFilesSelected(files);
      fileInput.value = "";
    }, "#file-input");

    on(demoLoadBtn, "click", () => {
      const demo = `
SwiftReader Demo — RSVP speed reading

This is a short demo text. Start at 300 WPM, then increase gradually.
Notice the red pivot letter: your eyes stay fixed, and comprehension stays smooth.

Try:
- Tap Play (mobile) or press Space (desktop) to play/pause
- Arrow keys to step
- Up/Down to change speed
- Add a note while reading

Paragraph two begins here. Commas, periods, and paragraph breaks can pause slightly to support comprehension.
`;
      importBuffer = {
        files: [],
        items: [],
        text: normalizeText(demo),
        sourceType: "paste",
        suggestedTitle: "SwiftReader Demo"
      };
      importTitle.value = "SwiftReader Demo";
      importAuthor.value = "";
      importTags.value = "demo, rsvp";
      setImportStatus("Demo text loaded.");
      showToast({ title: "Demo loaded", message: "Ready to add to your library.", type: "success" });
    }, "#demo-load-btn");

    on(importConfirmBtn, "click", async () => {
      setButtonLoading(importConfirmBtn, true, "Importing…");
      try {
        const author = (importAuthor.value || "").trim();
        const tags = (importTags.value || "")
          .split(",")
          .map(s => s.trim())
          .filter(Boolean);

        const bufferItems = Array.isArray(importBuffer.items) ? importBuffer.items : [];
        const hasItems = bufferItems.length > 0;
        if (!hasItems && !importBuffer.text) {
          // No file selected? Let user still add from file panel if they filled nothing.
          setImportStatus("Please choose a file or load demo text first.");
          showToast({ title: "Add text first", message: "Choose a file or load the demo text.", type: "error" });
          return;
        }
        if (bufferItems.length > 1) {
          const created = [];
          for (const item of bufferItems) {
            const book = await createBookFromText({
              title: item.suggestedTitle || "Untitled",
              author,
              tags,
              text: item.text,
              sourceType: item.sourceType || "paste",
              contentExtras: item.contentExtras,
              tokens: item.tokens,
              wordCount: item.wordCount,
              sourceMeta: item.sourceMeta
            });
            if (book?.sourceType === "pdf") {
              logPdfDiagnostic("PDF_BEFORE_SAVE_BOOK", { keys: Object.keys(book) });
            }
            upsertBook(book);
            if (book?.sourceType === "pdf") {
              logPdfDiagnostic("PDF_AFTER_SAVE_OK", { bookId: book.id });
            }
            created.push(book);
          }
          clearFileImportUI();
          const lastBook = created[created.length - 1];
          if (lastBook) {
            await openBookInReader(lastBook.id);
            setView("reader");
          }
          showToast({ title: "Books added", message: `${created.length} files imported.`, type: "success" });
          return;
        }

        const item = bufferItems[0];
        const title = (importTitle.value || item?.suggestedTitle || importBuffer.suggestedTitle || "Untitled").trim() || "Untitled";
        const book = await createBookFromText({
          title,
          author,
          tags,
          text: item?.text || importBuffer.text,
          sourceType: item?.sourceType || importBuffer.sourceType || "paste",
          contentExtras: item?.contentExtras,
          tokens: item?.tokens,
          wordCount: item?.wordCount,
          sourceMeta: item?.sourceMeta
        });

        if (book?.sourceType === "pdf") {
          logPdfDiagnostic("PDF_BEFORE_SAVE_BOOK", { keys: Object.keys(book) });
        }
        upsertBook(book);
        if (book?.sourceType === "pdf") {
          logPdfDiagnostic("PDF_AFTER_SAVE_OK", { bookId: book.id });
        }
        clearFileImportUI();

        // Auto-open in reader
        await openBookInReader(book.id);
        setView("reader");
        showToast({ title: "Book added", message: "Ready to read.", type: "success" });
      } finally {
        setButtonLoading(importConfirmBtn, false);
      }
    }, "#import-confirm-btn");

    on(importClearBtn, "click", () => clearFileImportUI(), "#import-clear-btn");

    // Paste import
    on(pasteAddBtn, "click", async () => {
      const text = normalizeText(pasteText.value || "");
      const title = (pasteTitle.value || "Pasted Text").trim() || "Pasted Text";
      if (!text) {
        setPasteStatus("Paste some text before adding.");
        showToast({ title: "Paste required", message: "Add some text to create a book.", type: "error" });
        return;
      }
      const book = await createBookFromText({
        title,
        author: "",
        tags: ["paste"],
        text,
        sourceType: "paste"
      });
      upsertBook(book);
      pasteText.value = "";
      pasteTitle.value = "";
      setPasteStatus("");
      await openBookInReader(book.id);
      setView("reader");
      showToast({ title: "Book added", message: "Ready to read.", type: "success" });
    }, "#paste-add-btn");

    on(pasteClearBtn, "click", () => {
      pasteText.value = "";
      pasteTitle.value = "";
      setPasteStatus("");
    }, "#paste-clear-btn");

    on(emptyDemoBtn, "click", () => demoLoadBtn?.click(), "#empty-demo-btn");
    on(emptyPasteBtn, "click", () => {
      setImportTab("paste");
      pasteText?.focus();
    }, "#empty-paste-btn");
    on(emptyHelpBtn, "click", () => openModal(modalHelp, emptyHelpBtn), "#empty-help-btn");

    // Library interactions
    on(librarySearch, "input", () => renderLibraryList(), "#library-search");
    on(librarySort, "change", () => renderLibraryList(), "#library-sort");

    on(dangerResetBtn, "click", async () => {
      const confirmed = await openConfirm({
        title: "Reset local data",
        message: "This will delete all local books and notes for SwiftReader. Continue?",
        confirmText: "Reset data"
      });
      if (!confirmed) return;
      state = defaultState();
      saveState();
      void resetIndexedDb();
      stopReader(true);
      selectedBookId = null;
      selectedNoteId = null;
      applyThemeFromSettings();
      applyReaderStyleSettings();
      hydrateSettingsUI();
      renderAll();
      setView("library");
      showToast({ title: "Data reset", message: "All local data has been cleared.", type: "success" });
    }, "#danger-reset-btn");

    // Sidebar export/import
    on(exportBtn, "click", () => void exportData(), "#export-btn");
    on(importDataBtn, "click", () => importData(importDataBtn), "#import-data-btn");

    // Reader controls
    on(btnPlay, "click", () => togglePlay(), "#btn-play");
    on(btnBack, "click", () => stepWords(-3), "#btn-back");
    on(btnForward, "click", () => stepWords(+3), "#btn-forward");
    on(btnBackSent, "click", () => stepSentence(-1), "#btn-back-sent");
    on(btnForwardSent, "click", () => stepSentence(+1), "#btn-forward-sent");
    on(btnMark, "click", () => addBookmark(), "#btn-mark");
    on(btnAddNote, "click", () => openAddNoteFromReader(), "#btn-add-note");

    on(wpmSlider, "input", () => {
      const v = Number(wpmSlider.value);
      state.settings.defaultWpm = v;
      wpmValue.textContent = String(v);
      saveState();
      if (selectedBookId) {
        updateBookReaderState(selectedBookId, { wpm: v });
      }
    }, "#wpm-slider");

    on(pauseSlider, "input", () => {
      const v = Number(pauseSlider.value);
      state.settings.punctuationPause = v;
      saveState();
      if (selectedBookId) {
        updateBookReaderState(selectedBookId, { pause: v });
      }
    }, "#pause-slider");

    on(progressSlider, "pointerdown", () => {
      scrubberActive = true;
      if (reader.isPlaying) stopReader(false);
    }, "#progress-slider");

    on(progressSlider, "input", () => {
      const value = Number(progressSlider.value);
      scheduleScrub(value, false);
    }, "#progress-slider");

    on(progressSlider, "change", () => {
      const value = Number(progressSlider.value);
      scrubberActive = false;
      scheduleScrub(value, true);
    }, "#progress-slider");

    // Reader quick note box
    on(saveNoteBtn, "click", () => {
      const text = (quickNote.value || "").trim();
      if (!selectedBookId) {
        showToast({ title: "No book selected", message: "Open a book before saving a note.", type: "error" });
        return;
      }
      if (!text) {
        showToast({ title: "Note is empty", message: "Type a note before saving.", type: "error" });
        return;
      }
      const book = getBook(selectedBookId);
      const idx = getCurrentTokenIndex();
      const wordIndex = getWordIndexForTokenIndex(book.id, idx);
      const excerpt = makeExcerpt(book, idx, 12);
      upsertNote({
        id: null,
        bookId: book.id,
        bookTitle: book.title,
        index: idx,
        wordIndex,
        excerpt,
        text
      });
      quickNote.value = "";
      renderReaderNotes();
      renderNotesView();
      showToast({ title: "Note saved", message: "Linked to the current book.", type: "success" });
    }, "#save-note-btn");

    on(clearNoteBtn, "click", () => (quickNote.value = ""), "#clear-note-btn");

    // Keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      // Ignore if typing in inputs/textareas/selects
      if (isEditableTarget(e.target)) return;
      if (activeModal) return;
      if (e.key === "Escape" && pdfState.isPseudoFullscreen) {
        setPdfPseudoFullscreen(false);
        return;
      }
      const readerView = $("#view-reader");
      if (!readerView || !readerView.classList.contains("is-active")) {
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

    // RSVP gestures (mobile-first)
    let gestureStart = null;
    on(rsvpFrame, "pointerdown", (e) => {
      const readerView = $("#view-reader");
      if (!readerView || !readerView.classList.contains("is-active")) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      gestureStart = {
        x: e.clientX,
        y: e.clientY,
        time: performance.now()
      };
      rsvpFrame.setPointerCapture?.(e.pointerId);
    }, ".rsvp-frame");

    on(rsvpFrame, "pointerup", (e) => {
      if (!state.settings.tapControls) return;
      const readerView = $("#view-reader");
      if (!readerView || !readerView.classList.contains("is-active")) return;
      if (!gestureStart) return;
      const dx = e.clientX - gestureStart.x;
      const dy = e.clientY - gestureStart.y;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const threshold = 40;

      if (e.pointerType === "touch") e.preventDefault();

      if (absX > threshold || absY > threshold) {
        if (absX > absY) {
          stepWords(dx > 0 ? 3 : -3);
        } else {
          bumpWpm(dy < 0 ? 10 : -10);
        }
        gestureStart = null;
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const third = rect.width / 3;
      if (x < third) stepWords(-1);
      else if (x > third * 2) stepWords(+1);
      else togglePlay();

      gestureStart = null;
    }, ".rsvp-frame");

    on(rsvpFrame, "pointercancel", () => {
      gestureStart = null;
    }, ".rsvp-frame");

    // Notes view
    on(notesSearch, "input", () => renderNotesView(), "#notes-search");
    on(notesFilterBook, "change", () => renderNotesView(), "#notes-filter-book");
    on(notesSort, "change", () => renderNotesView(), "#notes-sort");

    on(noteUpdateBtn, "click", () => {
      if (!selectedNoteId) return;
      const note = state.notes.find(n => n.id === selectedNoteId);
      if (!note) return;
      const text = (noteEdit.value || "").trim();
      if (!text) {
        showToast({ title: "Note is empty", message: "Add text before updating.", type: "error" });
        return;
      }
      upsertNote({ ...note, text });
      renderNotesView();
      // Keep selection
      selectNote(selectedNoteId);
      showToast({ title: "Note updated", message: "Your changes are saved.", type: "success" });
    }, "#note-update-btn");

    on(noteDeleteBtn, "click", async () => {
      if (!selectedNoteId) return;
      const note = state.notes.find(n => n.id === selectedNoteId);
      if (!note) return;
      const confirmed = await openConfirm({
        title: "Delete note",
        message: "Delete this note? This cannot be undone.",
        confirmText: "Delete note"
      });
      if (!confirmed) return;
      state.notes = state.notes.filter(n => n.id !== selectedNoteId);
      saveState();
      void idbDelete(DB_STORES.notes, selectedNoteId);
      selectedNoteId = null;
      clearNotePreview();
      renderNotesView();
      renderReaderNotes();
      showToast({ title: "Note deleted", message: "The note has been removed.", type: "success" });
    }, "#note-delete-btn");

    // Settings
    on(defaultWpmInput, "change", () => {
      const v = clamp(Number(defaultWpmInput.value), 150, 1200);
      state.settings.defaultWpm = v;
      wpmSlider.value = String(v);
      wpmValue.textContent = String(v);
      saveState();
    }, "#default-wpm");

    on(fontSizeSlider, "input", () => {
      const v = clamp(Number(fontSizeSlider.value), 22, 72);
      state.settings.fontSize = v;
      applyReaderStyleSettings();
      saveState();
    }, "#font-size");

    on(fontFamilySelect, "change", () => {
      state.settings.fontFamily = fontFamilySelect.value;
      applyReaderStyleSettings();
      saveState();
    }, "#font-family");

    on(chunkSizeSelect, "change", () => {
      const v = clamp(Number(chunkSizeSelect.value), 1, 4);
      state.settings.chunkSize = v;
      saveState();
    }, "#chunk-size");

    on(autoPauseCheckbox, "change", () => {
      state.settings.autoPause = !!autoPauseCheckbox.checked;
      saveState();
    }, "#auto-pause");

    on(tapControlsCheckbox, "change", () => {
      state.settings.tapControls = !!tapControlsCheckbox.checked;
      saveState();
    }, "#tap-controls");

    on(wakeLockCheckbox, "change", async () => {
      state.settings.wakeLock = !!wakeLockCheckbox.checked;
      saveState();
      if (state.settings.wakeLock) {
        await requestWakeLock();
      } else {
        await releaseWakeLock();
      }
    }, "#wake-lock");

    on(rememberLastBookCheckbox, "change", () => {
      state.settings.rememberLastBook = !!rememberLastBookCheckbox.checked;
      saveState();
    }, "#remember-last-book");

    on(autoRemoveHeadersCheckbox, "change", () => {
      state.settings.autoRemoveHeadersFooters = !!autoRemoveHeadersCheckbox.checked;
      saveState();
    }, "#auto-remove-headers");

    on(customIgnorePhrasesInput, "change", () => {
      state.settings.customIgnorePhrases = customIgnorePhrasesInput.value || "";
      saveState();
    }, "#custom-ignore-phrases");

    // Export/import from settings too
    on(settingsExportBtn, "click", () => void exportData(), "#settings-export-btn");
    on(settingsImportBtn, "click", () => importData(settingsImportBtn), "#settings-import-btn");
    on(repairStorageBtn, "click", () => {
      showToast({
        title: "Repair storage",
        message: "Export raw storage before repairing (recommended).",
        type: "info",
        duration: 8000,
        actions: [
          { label: "Export raw storage", handler: () => exportRawStorage() },
          { label: "Repair now", handler: () => repairStorage() }
        ]
      });
    }, "#repair-storage-btn");

    on(settingsResetBtn, "click", () => dangerResetBtn?.click(), "#settings-reset-btn");

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.settings.wakeLock && reader.isPlaying) {
        void requestWakeLock();
      }
      if (document.visibilityState === "hidden") {
        void releaseWakeLock();
      }
    });

    document.addEventListener("fullscreenchange", () => {
      updatePdfFullscreenButton();
      if (pdfState.doc && pdfState.currentBookId === selectedBookId) {
        schedulePdfRender();
      }
    });

    window.addEventListener("resize", () => {
      scheduleRsvpFit();
      setReaderMode(state.settings.readerMode || (isNarrowReaderLayout() ? "page" : "rsvp"), { persist: false });
      if (pdfState.doc && pdfState.currentBookId === selectedBookId) {
        schedulePdfRender();
      }
    });

    // Footer optional hooks
    on(aboutBtn, "click", () => {
      void openConfirm({
        title: "About SwiftReader",
        message: "SwiftReader is a local-first speed reading tool. No accounts, no tracking — your data stays in your browser unless you export.",
        confirmText: "Got it",
        cancelText: "Close",
        hideCancel: true
      });
    }, "#about-btn");
    on(shortcutsBtn, "click", () => {
      void openConfirm({
        title: "Reader shortcuts",
        message: "Tap Play (mobile) or press Space (desktop) to play/pause.\n← / →: Step word\n↑ / ↓: Change speed",
        confirmText: "Got it",
        cancelText: "Close",
        hideCancel: true
      });
    }, "#shortcuts-btn");
    return bindings;
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
      if (pdfState.isPseudoFullscreen) setPdfPseudoFullscreen(false);
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
    tabFile?.classList.toggle("is-active", isFile);
    tabPaste?.classList.toggle("is-active", !isFile);

    tabFile?.setAttribute("aria-selected", String(isFile));
    tabPaste?.setAttribute("aria-selected", String(!isFile));

    panelFile?.classList.toggle("is-active", isFile);
    panelPaste?.classList.toggle("is-active", !isFile);

    if (panelFile) panelFile.hidden = !isFile;
    if (panelPaste) panelPaste.hidden = isFile;
  }

  /* ---------------------------
     Service worker
  --------------------------- */
  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.warn("Service worker registration failed", err);
    });
  }

  /* ---------------------------
     Modal
  --------------------------- */
  function getFocusableElements(modal) {
    if (!modal) return [];
    return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(el => !el.hasAttribute("disabled") && !el.getAttribute("aria-hidden"));
  }

  function handleModalKeydown(e) {
    if (!activeModal) return;
    if (e.key === "Escape") {
      if (activeModal === modalConfirm) {
        resolveConfirm(false);
      } else {
        closeModal(activeModal);
      }
      return;
    }
    if (e.key !== "Tab") return;

    const focusable = getFocusableElements(activeModal);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function lockBodyScroll() {
    if (scrollLocked) return;
    scrollLocked = true;
    scrollLockY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add("modal-open");
    document.body.style.top = `-${scrollLockY}px`;
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
  }

  function unlockBodyScroll() {
    if (!scrollLocked) return;
    scrollLocked = false;
    document.body.classList.remove("modal-open");
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, scrollLockY);
  }

  function openModal(el, opener) {
    if (!el) return;
    if (activeModal && activeModal !== el) closeModal(activeModal, { restoreFocus: false, keepScrollLock: true });
    activeModal = el;
    lastFocusedEl = opener || document.activeElement;
    el.hidden = false;
    lockBodyScroll();
    document.addEventListener("keydown", handleModalKeydown);
    const focusable = getFocusableElements(el);
    const btn = el.querySelector("[data-close='true']") || focusable[0];
    btn?.focus();
  }

  function closeModal(el, { restoreFocus = true, keepScrollLock = false } = {}) {
    if (!el) return;
    el.hidden = true;
    if (activeModal === el) {
      activeModal = null;
    }
    if (!keepScrollLock) unlockBodyScroll();
    document.removeEventListener("keydown", handleModalKeydown);
    if (restoreFocus) lastFocusedEl?.focus?.();
  }

  function openConfirm({ title, message, confirmText = "Confirm", cancelText = "Cancel", hideCancel = false } = {}) {
    if (!modalConfirm || !confirmOkBtn || !confirmTitle || !confirmMessage || !confirmCancelBtn) {
      showToast({ title: "Confirmation unavailable", message: "Unable to open confirmation dialog.", type: "error" });
      return Promise.resolve(false);
    }
    confirmTitle.textContent = title || "Confirm action";
    confirmMessage.textContent = message || "Are you sure you want to continue?";
    confirmOkBtn.textContent = confirmText;
    confirmCancelBtn.textContent = cancelText;
    confirmCancelBtn.hidden = !!hideCancel;
    openModal(modalConfirm, document.activeElement);
    return new Promise(resolve => {
      confirmResolver = resolve;
    });
  }

  function resolveConfirm(result) {
    if (activeModal === modalConfirm) closeModal(modalConfirm);
    if (confirmResolver) {
      confirmResolver(!!result);
      confirmResolver = null;
    }
  }

  function showToast({ title, message, type = "info", duration = 3200, action, actions } = {}) {
    if (!toastRegion) return;
    const actionList = Array.isArray(actions)
      ? actions
      : (action && action.label && typeof action.onClick === "function")
        ? [{ label: action.label, handler: action.onClick }]
        : [];
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.dataset.type = type;

    if (title) {
      const t = document.createElement("div");
      t.className = "toast-title";
      t.textContent = title;
      toast.appendChild(t);
    }

    if (message) {
      const m = document.createElement("div");
      m.className = "toast-text";
      m.textContent = message;
      toast.appendChild(m);
    }

    if (actionList.length) {
      const actions = document.createElement("div");
      actions.className = "toast-actions";
      actionList.forEach(entry => {
        const btn = document.createElement("button");
        btn.className = "btn btn-secondary btn-sm";
        btn.type = "button";
        btn.textContent = entry.label;
        btn.addEventListener("click", () => {
          entry.handler?.();
          toast.remove();
        });
        actions.appendChild(btn);
      });
      toast.appendChild(actions);
    }

    toastRegion.appendChild(toast);
    if (duration > 0) {
      setTimeout(() => toast.remove(), duration);
    }
  }

  /* ---------------------------
     Theme
  --------------------------- */
  function applyThemeFromSettings() {
    const theme = state.settings.theme || "system";
    const root = document.documentElement;
    const themeIcon = themeToggleBtn?.querySelector(".icon");

    if (theme === "system") {
      root.removeAttribute("data-theme");
      if (themeIcon) themeIcon.textContent = "☾";
      return;
    }

    root.setAttribute("data-theme", theme);
    if (themeIcon) themeIcon.textContent = theme === "dark" ? "☾" : "☀";
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
    const rsvpWord = $("#rsvp-word");
    if (rsvpWord) rsvpWord.style.fontFamily = fam;
    scheduleRsvpFit();
  }

  function hydrateSettingsUI() {
    if (defaultWpmInput) defaultWpmInput.value = String(state.settings.defaultWpm || 300);
    if (wpmSlider) wpmSlider.value = String(state.settings.defaultWpm || 300);
    if (wpmValue) wpmValue.textContent = String(state.settings.defaultWpm || 300);

    if (fontSizeSlider) fontSizeSlider.value = String(state.settings.fontSize || 46);
    if (fontFamilySelect) fontFamilySelect.value = state.settings.fontFamily || "system";
    if (chunkSizeSelect) chunkSizeSelect.value = String(state.settings.chunkSize || 1);

    if (autoPauseCheckbox) autoPauseCheckbox.checked = !!state.settings.autoPause;
    if (tapControlsCheckbox) tapControlsCheckbox.checked = !!state.settings.tapControls;
    if (wakeLockCheckbox) wakeLockCheckbox.checked = !!state.settings.wakeLock;
    if (rememberLastBookCheckbox) rememberLastBookCheckbox.checked = !!state.settings.rememberLastBook;
    if (autoRemoveHeadersCheckbox) autoRemoveHeadersCheckbox.checked = !!state.settings.autoRemoveHeadersFooters;
    if (customIgnorePhrasesInput) customIgnorePhrasesInput.value = state.settings.customIgnorePhrases || "";

    if (pauseSlider) pauseSlider.value = String(state.settings.punctuationPause ?? 80);
  }

  async function requestWakeLock() {
    if (!state.settings.wakeLock) return;
    if (!("wakeLock" in navigator)) {
      state.settings.wakeLock = false;
      if (wakeLockCheckbox) wakeLockCheckbox.checked = false;
      saveState();
      showToast({ title: "Wake Lock unavailable", message: "This browser does not support keeping the screen awake.", type: "info" });
      return;
    }
    try {
      wakeLockHandle = await navigator.wakeLock.request("screen");
      wakeLockHandle.addEventListener("release", () => {
        wakeLockHandle = null;
      });
    } catch (err) {
      console.warn("Wake Lock request failed", err);
      showToast({ title: "Wake Lock failed", message: "Unable to keep the screen awake.", type: "error" });
    }
  }

  async function releaseWakeLock() {
    if (!wakeLockHandle) return;
    try {
      await wakeLockHandle.release();
      wakeLockHandle = null;
    } catch (err) {
      console.warn("Wake Lock release failed", err);
    }
  }

  /* ---------------------------
     Storage estimate (best-effort)
  --------------------------- */
  async function updateStorageEstimate() {
    try {
      if (!storageEstimate) return;
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
  function setImportStatus(message) {
    if (!importStatus) return;
    importStatus.textContent = message || "";
  }

  function setPasteStatus(message) {
    if (!pasteStatus) return;
    pasteStatus.textContent = message || "";
  }

  function normalizeLineForMatch(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function removeDigits(text) {
    return String(text || "").replace(/\d+/g, "").trim();
  }

  function parseCustomIgnorePhrases(raw) {
    return String(raw || "")
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
  }

  function isPageNumberLike(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return false;
    const compact = trimmed.replace(/\s+/g, "");
    if (/^[\W_]*\d+[\W_]*$/.test(compact)) return true;
    if (/^\d+\s*\/\s*\d+$/.test(trimmed)) return true;
    if (/^page\s*\d+(\s*(of|\/)\s*\d+)?/i.test(trimmed)) return true;
    if (/^[\W_]*[ivxlcdm]+[\W_]*$/i.test(compact)) return true;
    return false;
  }

  function extractPdfLines(content, pageIndex, pageHeight) {
    const items = (content?.items || [])
      .map(item => ({
        text: item?.str || "",
        x: item?.transform?.[4] || 0,
        y: item?.transform?.[5] || 0
      }))
      .filter(item => item.text.trim().length);

    items.sort((a, b) => {
      if (Math.abs(b.y - a.y) > 1) return b.y - a.y;
      return a.x - b.x;
    });

    const lines = [];
    const tolerance = 2;
    for (const item of items) {
      const last = lines[lines.length - 1];
      if (!last || Math.abs(last.y - item.y) > tolerance) {
        lines.push({ y: item.y, items: [item] });
      } else {
        last.items.push(item);
      }
    }

    return lines.map(line => {
      const text = line.items
        .sort((a, b) => a.x - b.x)
        .map(i => i.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        pageIndex,
        y: line.y,
        text,
        pageHeight
      };
    }).filter(line => line.text.length);
  }

  function buildPdfStripRules(pages, options = {}) {
    const totalPages = pages.length || 0;
    const topBand = options.topBand ?? 0.15;
    const bottomBand = options.bottomBand ?? 0.15;
    const minPct = options.minFrequency ?? 0.35;
    const minLen = options.minLength ?? 3;
    const maxLen = options.maxLength ?? 90;
    const lineMap = new Map();

    pages.forEach(page => {
      const height = page.pageHeight || 0;
      const topMin = height * (1 - topBand);
      const bottomMax = height * bottomBand;
      const seen = new Set();
      (page.lines || []).forEach(line => {
        if (line.y < bottomMax || line.y > topMin) {
          const norm = normalizeLineForMatch(line.text);
          const normNoDigits = removeDigits(norm);
          const candidates = [norm, normNoDigits].filter(Boolean);
          candidates.forEach(key => {
            if (key.length < minLen || key.length > maxLen) return;
            if (seen.has(key)) return;
            seen.add(key);
            if (!lineMap.has(key)) lineMap.set(key, new Set());
            lineMap.get(key).add(page.pageIndex);
          });
        }
      });
    });

    const removeSet = new Set();
    lineMap.forEach((pagesSet, key) => {
      if (totalPages && pagesSet.size / totalPages >= minPct) {
        removeSet.add(key);
      }
    });

    const customPhrases = (options.customPhrases || [])
      .map(phrase => normalizeLineForMatch(phrase))
      .filter(Boolean);

    return { removeSet, customPhrases };
  }

  function stripPdfHeadersFooters(pages, options = {}) {
    if (!pages.length) return { pageTexts: [], pageRanges: [] };
    const enabled = options.enabled !== false;
    const rules = buildPdfStripRules(pages, options);

    const pageTexts = pages.map(page => {
      const filtered = (page.lines || []).filter(line => {
        if (!enabled && !rules.customPhrases.length) return true;
        const rawText = line.text.trim();
        if (!rawText) return false;
        const norm = normalizeLineForMatch(rawText);
        const normNoDigits = removeDigits(norm);
        const wordCount = rawText.split(/\s+/).filter(Boolean).length;
        if (rawText.length > 120 || wordCount > 15) return true;
        if (isPageNumberLike(rawText)) return false;
        if (rules.removeSet.has(norm) || rules.removeSet.has(normNoDigits)) return false;
        if (rules.customPhrases.length) {
          const matchesCustom = rules.customPhrases.some(phrase => norm.includes(phrase) || normNoDigits.includes(phrase));
          if (matchesCustom) return false;
        }
        return true;
      });

      const ordered = filtered
        .sort((a, b) => b.y - a.y)
        .map(line => line.text)
        .join("\n");
      return normalizeText(ordered);
    });

    return { pageTexts };
  }

  function buildPdfContentFromPages(pages, options = {}) {
    const { pageTexts } = stripPdfHeadersFooters(pages, options);
    const tokensByPage = pageTexts.map(text => tokenize(text));
    const wordCounts = tokensByPage.map(tokens => countWords(tokens));
    let cursor = 0;
    const pageRanges = wordCounts.map((wordCount, idx) => {
      const start = cursor;
      const end = wordCount ? cursor + wordCount - 1 : cursor;
      cursor += wordCount;
      return {
        page: idx + 1,
        start,
        end,
        wordCount
      };
    });
    const combinedText = pageTexts.join("\n\n");
    const combinedTokens = tokensByPage.flat();
    return {
      text: combinedText,
      tokens: combinedTokens,
      wordCount: countWords(combinedTokens),
      pageRanges
    };
  }

  async function extractTextFromPdf(file, onStatus) {
    const pdfjsLib = window["pdfjs-dist/build/pdf"];
    if (!pdfjsLib) {
      throw new Error("PDF.js not available");
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const buffer = await file.arrayBuffer();
    const fileData = buffer.slice(0);
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    const pdf = await loadingTask.promise;
    const totalPages = pdf.numPages || 0;
    const pages = [];

    for (let i = 1; i <= totalPages; i += 1) {
      onStatus?.(`Extracting PDF… page ${i} / ${totalPages}`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const lines = extractPdfLines(content, i, viewport.height);
      const normalizedPageText = normalizeText(lines.map(line => line.text).join("\n"));
      pages.push({
        pageIndex: i,
        pageHeight: viewport.height,
        lines,
        text: normalizedPageText
      });
      await sleep(0);
    }

    const combined = pages.map(p => p.text).join("\n\n");
    if (totalPages > 1 && combined.trim().length < 300) {
      onStatus?.("Scanned PDF detected.");
    }
    return { pages, text: combined, totalPages, fileData };
  }

  async function extractTextFromEpub(file, onStatus) {
    const epubLib = window.ePub;
    if (!epubLib) {
      throw new Error("epub.js not available");
    }
    if (!window.JSZip) {
      onStatus?.("EPUB support missing (JSZip not loaded).");
      showToast({ title: "EPUB support missing", message: "JSZip is required to import EPUB files.", type: "error" });
      return { title: "", text: "", fileData: null };
    }
    const buffer = await file.arrayBuffer();
    const fileData = cloneArrayBuffer(buffer);
    let book = null;
    try {
      book = epubLib(buffer);
      await book.ready;
      const metadata = await book.loaded.metadata;
      await book.loaded.spine;
      const sections = book.spine?.spineItems || book.spine?.items || [];
      const chunks = [];

      for (let i = 0; i < sections.length; i += 1) {
        const section = sections[i];
        onStatus?.(`Extracting EPUB… ${i + 1} / ${sections.length}`);
        let contents = null;
        try {
          if (section?.load && typeof section.load === "function") {
            contents = await section.load(book.load.bind(book));
          } else if (section?.href) {
            contents = await book.load(section.href);
          } else if (book.spine?.get && section?.idref) {
            const resolved = book.spine.get(section.idref);
            if (resolved?.load) {
              contents = await resolved.load(book.load.bind(book));
            }
          }
        } catch (err) {
          console.warn("EPUB section load failed", err);
        }
        const doc = contents?.document || contents;
        const bodyText = doc?.body ? doc.body.textContent : "";
        if (bodyText) chunks.push(sanitizeExtractedText(bodyText));
        if (section?.unload) section.unload();
        if (contents?.unload) contents.unload();
        await sleep(0);
      }

      return {
        title: metadata?.title || "",
        text: chunks.join("\n\n"),
        fileData
      };
    } catch (err) {
      console.warn("EPUB text extraction failed", err);
      return { title: "", text: "", fileData };
    } finally {
      if (book?.destroy) {
        book.destroy();
      }
    }
  }
  async function parseImportFile(file, index, total) {
    const name = file.name || "Untitled";
    const lower = name.toLowerCase();
    const sourceMeta = {
      filename: name,
      fileType: file.type || "",
      size: typeof file.size === "number" ? file.size : null
    };
    setImportStatus(total > 1 ? `Reading ${index + 1} / ${total}…` : "Reading file…");

    if (lower.endsWith(".txt") || lower.endsWith(".md")) {
      const baseTitle = name.replace(/\.(txt|md)$/i, "");
      const text = await fileToTextAsync(file);
      return {
        file,
        text: normalizeText(text),
        sourceType: lower.endsWith(".md") ? "md" : "txt",
        suggestedTitle: baseTitle,
        sourceMeta,
        contentExtras: {
          fileType: file.type || "text/plain"
        }
      };
    }

    if (lower.endsWith(".pdf")) {
      const baseTitle = name.replace(/\.pdf$/i, "");
      logPdfDiagnostic("PDF_UPLOAD_START", {
        filename: name,
        size: file.size || null,
        type: file.type || "application/pdf"
      });
      try {
        const result = await extractTextFromPdf(file, status => setImportStatus(status));
        const text = result?.text || "";
        const totalPages = result?.totalPages || 1;
        if (totalPages > 1 && text.trim().length < 300) {
          setImportStatus("Scanned PDF detected.");
          showToast({ title: "Scanned PDF detected", message: "OCR is not supported yet.", type: "error" });
          return null;
        }
        if (!text || text.length < 40) {
          setImportStatus("No text found in PDF.");
          showToast({ title: "No text found", message: "This PDF may be scanned or image-based.", type: "error" });
          return null;
        }
        const stripOptions = {
          enabled: state.settings.autoRemoveHeadersFooters,
          customPhrases: parseCustomIgnorePhrases(state.settings.customIgnorePhrases)
        };
        const { text: strippedText, tokens, wordCount, pageRanges } = buildPdfContentFromPages(result.pages || [], stripOptions);
        return {
          file,
          text: normalizeText(strippedText || text),
          tokens,
          wordCount,
          sourceType: "pdf",
          suggestedTitle: baseTitle,
          sourceMeta,
          contentExtras: {
            fileData: result?.fileData || null,
            fileType: file.type || "application/pdf",
            pageRanges,
            pdfTotalPages: totalPages
          }
        };
      } catch (err) {
        console.error("PDF import failed", err);
        setImportStatus("PDF import failed.");
        showToast({ title: "PDF import failed", message: "Please try another PDF.", type: "error" });
        return null;
      }
    }

    if (lower.endsWith(".epub")) {
      const baseTitle = name.replace(/\.epub$/i, "");
      if (!window.ePub) {
        setImportStatus("EPUB viewer unavailable.");
        showToast({ title: "EPUB unavailable", message: "EPUB support is not loaded yet.", type: "error" });
        return null;
      }
      if (!window.JSZip) {
        setImportStatus("EPUB support missing (JSZip not loaded).");
        showToast({ title: "EPUB support missing", message: "JSZip is required to import EPUB files.", type: "error" });
        return null;
      }
      const { text, title, fileData } = await extractTextFromEpub(file, status => setImportStatus(status));
      if (!text || text.length < 40) {
        if (!fileData) {
          setImportStatus("No readable text found in EPUB.");
          showToast({ title: "EPUB unreadable", message: "This EPUB appears to be empty or protected.", type: "error" });
          return null;
        }
        setImportStatus("EPUB text extraction failed.");
        showToast({
          title: "Limited EPUB import",
          message: "Text extraction failed, but the EPUB viewer should still work.",
          type: "warning"
        });
      }
      return {
        file,
        text: normalizeText(text),
        sourceType: "epub",
        suggestedTitle: title || baseTitle,
        sourceMeta,
        contentExtras: {
          fileData,
          fileType: file.type || "application/epub+zip"
        }
      };
    }

    showToast({ title: "Unsupported file", message: "Choose TXT, MD, EPUB, or PDF.", type: "error" });
    return null;
  }

  async function handleFilesSelected(files) {
    if (!files || files.length === 0) return;
    const items = [];
    try {
      for (let i = 0; i < files.length; i += 1) {
        const item = await parseImportFile(files[i], i, files.length);
        if (item) items.push(item);
      }

      if (!items.length) {
        setImportStatus("No readable files selected.");
        return;
      }

      const primary = items[0];
      importBuffer = {
        files: items.map(item => item.file),
        items,
        text: primary.text || "",
        sourceType: primary.sourceType || null,
        suggestedTitle: primary.suggestedTitle || ""
      };

      if (items.length === 1) {
        if (!importTitle.value.trim()) importTitle.value = primary.suggestedTitle || "";
        setImportStatus(`Loaded ${primary.file.name}`);
      } else {
        importTitle.value = "";
        setImportStatus(`Loaded ${items.length} files. Click Add to Library to import all.`);
      }
    } catch (err) {
      console.error(err);
      setImportStatus("Import failed.");
      showToast({
        title: "Import failed",
        message: err instanceof Error ? err.message : "Please try another file.",
        type: "error"
      });
    }
  }

  function clearFileImportUI() {
    importTitle.value = "";
    importAuthor.value = "";
    importTags.value = "";
    importBuffer = { files: [], items: [], text: "", sourceType: null, suggestedTitle: "" };
    setImportStatus("");
  }

  async function createBookFromText({ title, author, tags, text, sourceType, contentExtras, tokens: tokenOverride, wordCount: wordCountOverride, sourceMeta }) {
    const normalizedText = normalizeText(text);
    const tokens = Array.isArray(tokenOverride) ? tokenOverride : tokenize(normalizedText);
    const wc = typeof wordCountOverride === "number" ? wordCountOverride : countWords(tokens);
    const book = {
      id: uid("book"),
      title: title || "Untitled",
      author: author || "",
      tags: Array.isArray(tags) ? tags : [],
      addedAt: nowISO(),
      updatedAt: nowISO(),
      sourceType: sourceType || "paste",
      source: {
        filename: sourceMeta?.filename || "",
        fileType: sourceMeta?.fileType || "",
        size: typeof sourceMeta?.size === "number" ? sourceMeta.size : null
      },
      text: "",
      tokens: [],
      wordCount: wc,
      tokenCount: tokens.length,
      contentStored: "idb",
      progress: { index: 0, updatedAt: nowISO(), bookmarks: [] },
      stats: { openedAt: null, lastSessionAt: null, totalReadWords: 0 }
    };
    await persistBookContentToIdb(book.id, normalizedText, tokens, contentExtras || {});
    return book;
  }

  async function ensureBookContent(bookId) {
    if (!bookId) return null;
    if (contentCache.has(bookId)) return contentCache.get(bookId);

    const book = getBook(bookId);
    if (!book) return null;

    // Try IndexedDB first
    if (idbReady) {
      const content = await idbGet(DB_STORES.contents, bookId);
      if (content && (content.rawText || content.tokens?.length)) {
        const merged = mergePunctuationTokens(content.tokens || []);
        if (merged.changed) {
          const wordIndex = getWordIndexForTokenIndexFromTokens(content.tokens || [], book.progress?.index ?? 0);
          const updatedIndex = getTokenIndexForWordIndexFromTokens(merged.tokens, wordIndex);
          const updatedBook = {
            ...book,
            tokenCount: merged.tokens.length,
            wordCount: countWords(merged.tokens),
            progress: {
              ...book.progress,
              index: updatedIndex,
              updatedAt: nowISO()
            },
            readerState: {
              ...book.readerState,
              currentWordIndex: wordIndex
            }
          };
          upsertBook(updatedBook);
          const extras = { ...content };
          delete extras.bookId;
          delete extras.rawText;
          delete extras.tokens;
          delete extras.tokenCount;
          delete extras.updatedAt;
          await persistBookContentToIdb(bookId, content.rawText || "", merged.tokens, extras);
          return contentCache.get(bookId);
        }
        contentCache.set(bookId, content);
        if (!book.tokenCount && content.tokenCount) {
          upsertBook({ ...book, tokenCount: content.tokenCount });
        }
        return content;
      }
    }

    // Fallback to localStorage legacy content
    if (book.text || (book.tokens && book.tokens.length)) {
      const text = book.text || "";
      let tokens = [];
      if (book.tokens && book.tokens.length) {
        const merged = mergePunctuationTokens(book.tokens);
        tokens = merged.tokens;
        if (merged.changed) {
          const wordIndex = getWordIndexForTokenIndexFromTokens(book.tokens, book.progress?.index ?? 0);
          const updatedIndex = getTokenIndexForWordIndexFromTokens(tokens, wordIndex);
          upsertBook({
            ...book,
            tokenCount: tokens.length,
            wordCount: countWords(tokens),
            progress: {
              ...book.progress,
              index: updatedIndex,
              updatedAt: nowISO()
            },
            readerState: {
              ...book.readerState,
              currentWordIndex: wordIndex
            }
          });
        }
      } else {
        tokens = tokenize(text);
      }
      const content = {
        bookId,
        rawText: text,
        tokens,
        tokenCount: tokens.length,
        updatedAt: nowISO(),
        pageRanges: [],
        fileData: null,
        fileType: null,
        pdfTotalPages: null
      };
      contentCache.set(bookId, content);
      await persistBookContentToIdb(bookId, text, tokens);
      if (!book.tokenCount || !book.wordCount) {
        const wordCount = countWords(tokens);
        upsertBook({ ...book, wordCount, tokenCount: tokens.length });
      }
      return content;
    }

    return null;
  }

  /* ---------------------------
     Library rendering
  --------------------------- */
  function renderLibraryList() {
    if (!bookList || !libraryEmpty) return;
    const q = (librarySearch?.value || "").trim().toLowerCase();
    const sort = librarySort?.value || "recent";

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
      btn.addEventListener("click", async () => {
        await openBookInReader(b.id);
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
      btn.addEventListener("contextmenu", async (e) => {
        e.preventDefault();
        const action = prompt(`Book actions:\n1) Delete\n2) Rename\n\nType 1 or 2`, "");
        if (action === "1") {
          const confirmed = await openConfirm({
            title: "Delete book",
            message: `Delete "${b.title}" and its notes? This cannot be undone.`,
            confirmText: "Delete book"
          });
          if (!confirmed) return;
          deleteBook(b.id);
          renderAll();
          showToast({ title: "Book deleted", message: "The book and notes were removed.", type: "success" });
        } else if (action === "2") {
          const newTitle = prompt("New title:", b.title);
          if (newTitle && newTitle.trim()) {
            upsertBook({ ...b, title: newTitle.trim(), updatedAt: nowISO() });
            renderAll();
            showToast({ title: "Book renamed", message: "Title updated.", type: "success" });
          }
        }
      });

      li.appendChild(btn);
      bookList.appendChild(li);
    }
  }

  function computeProgressPct(book) {
    const totalWords = Math.max(1, getTotalWordsForBook(book));
    const idx = clamp(book.progress?.index ?? 0, 0, Math.max(0, getTokenCountForBook(book) - 1));
    const wordIdx = getWordIndexForTokenIndex(book?.id, idx);
    return Math.round((wordIdx / Math.max(1, totalWords - 1)) * 100);
  }

  function getWordIndexMap(bookId) {
    if (!bookId) return null;
    if (wordIndexCache.has(bookId)) return wordIndexCache.get(bookId);
    const tokens = getCachedTokens(bookId);
    if (!tokens.length) return null;
    const wordIndexToToken = [];
    const tokenIndexToWord = new Array(tokens.length).fill(-1);
    let wordIndex = 0;
    tokens.forEach((tok, i) => {
      if (tok.kind === "word") {
        wordIndexToToken.push(i);
        tokenIndexToWord[i] = wordIndex;
        wordIndex += 1;
      }
    });
    const map = { wordIndexToToken, tokenIndexToWord };
    wordIndexCache.set(bookId, map);
    return map;
  }

  function getTotalWordsForBook(book) {
    if (!book) return 0;
    if (typeof book.wordCount === "number") return book.wordCount;
    const map = getWordIndexMap(book.id);
    return map ? map.wordIndexToToken.length : 0;
  }

  function getWordIndexForTokenIndex(bookId, tokenIndex) {
    const map = getWordIndexMap(bookId);
    if (!map) return 0;
    let idx = clamp(tokenIndex, 0, map.tokenIndexToWord.length - 1);
    let wordIdx = map.tokenIndexToWord[idx];
    while (idx > 0 && wordIdx < 0) {
      idx -= 1;
      wordIdx = map.tokenIndexToWord[idx];
    }
    return Math.max(0, wordIdx);
  }

  function getTokenIndexForWordIndex(bookId, wordIndex) {
    const map = getWordIndexMap(bookId);
    if (!map) return 0;
    const clamped = clamp(wordIndex, 0, Math.max(0, map.wordIndexToToken.length - 1));
    return map.wordIndexToToken[clamped] ?? 0;
  }

  function getCachedTokens(bookId) {
    const cached = contentCache.get(bookId);
    if (cached && Array.isArray(cached.tokens)) return cached.tokens;
    const book = getBook(bookId);
    if (book && Array.isArray(book.tokens)) return book.tokens;
    return [];
  }

  function getTokenCountForBook(book) {
    if (!book) return 0;
    const cached = contentCache.get(book.id);
    if (cached && typeof cached.tokenCount === "number") return cached.tokenCount;
    if (typeof book.tokenCount === "number") return book.tokenCount;
    return Array.isArray(book.tokens) ? book.tokens.length : 0;
  }

  function buildPageMap(bookId) {
    if (!bookId) return [];
    if (pageMapCache.has(bookId)) return pageMapCache.get(bookId);
    const tokens = getCachedTokens(bookId);
    if (!tokens.length) return [];

    const paragraphs = [];
    let current = {
      startTokenIndex: null,
      endTokenIndex: null,
      wordOffsets: [],
      text: "",
      wordStartIndex: null,
      wordEndIndex: null
    };
    let cursor = 0;
    let globalWordIndex = 0;

    const finalizeParagraph = () => {
      if (!current.text) return;
      current.endTokenIndex = current.endTokenIndex ?? current.startTokenIndex ?? 0;
      current.wordStartIndex = current.wordOffsets.length ? current.wordOffsets[0].wordIndex : globalWordIndex;
      current.wordEndIndex = current.wordOffsets.length
        ? current.wordOffsets[current.wordOffsets.length - 1].wordIndex
        : current.wordStartIndex;
      paragraphs.push(current);
      current = {
        startTokenIndex: null,
        endTokenIndex: null,
        wordOffsets: [],
        text: "",
        wordStartIndex: null,
        wordEndIndex: null
      };
      cursor = 0;
    };

    tokens.forEach((tok, i) => {
      if (tok.kind === "para") {
        finalizeParagraph();
        return;
      }

      if (current.startTokenIndex === null) current.startTokenIndex = i;
      current.endTokenIndex = i;

      if (tok.kind === "word") {
        if (current.text) {
          current.text += " ";
          cursor += 1;
        }
        const start = cursor;
        current.text += tok.t;
        cursor += tok.t.length;
        current.wordOffsets.push({
          tokenIndex: i,
          wordIndex: globalWordIndex,
          start,
          end: cursor
        });
        globalWordIndex += 1;
      } else if (tok.kind === "punct") {
        current.text += tok.t;
        cursor += tok.t.length;
      }
    });

    finalizeParagraph();
    pageMapCache.set(bookId, paragraphs);
    return paragraphs;
  }

  function getPageRangesForBook(bookId) {
    const content = contentCache.get(bookId);
    if (!content || !Array.isArray(content.pageRanges)) return [];
    return content.pageRanges;
  }

  function getPdfPageForWordIndex(bookId, wordIndex) {
    const ranges = getPageRangesForBook(bookId);
    if (!ranges.length) return 1;
    let lo = 0;
    let hi = ranges.length - 1;
    let result = ranges[0].page;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const range = ranges[mid];
      if (wordIndex < range.start) {
        hi = mid - 1;
      } else if (wordIndex > range.end) {
        lo = mid + 1;
      } else {
        return range.page;
      }
      result = range.page;
    }
    return result;
  }

  function getWordStartForPdfPage(bookId, page) {
    const ranges = getPageRangesForBook(bookId);
    const match = ranges.find(r => r.page === page);
    return match ? match.start : 0;
  }

  function setViewerStatus(message) {
    if (viewerStatus) viewerStatus.textContent = message || "";
  }

  function showViewerType(type) {
    if (documentViewer) documentViewer.hidden = type === "text";
    if (pdfViewer) pdfViewer.hidden = type !== "pdf";
    if (epubViewer) epubViewer.hidden = type !== "epub";
    if (pageView) pageView.hidden = type !== "text";
    if (viewerControls) viewerControls.hidden = type !== "pdf";
    if (type === "empty") {
      if (documentViewer) documentViewer.hidden = false;
      if (pageView) pageView.hidden = true;
      if (pdfViewer) pdfViewer.hidden = true;
      if (epubViewer) epubViewer.hidden = true;
      if (viewerControls) viewerControls.hidden = true;
    }
  }

  function resetPdfViewer() {
    pdfState.doc = null;
    pdfState.page = 1;
    pdfState.total = 1;
    pdfState.fitScale = 1;
    pdfState.renderScale = 1;
    pdfState.canvasWidth = 0;
    pdfState.canvasHeight = 0;
    pdfState.scale = 1;
    pdfState.fitMode = "width";
    pdfState.pendingScroll = null;
    pdfState.rendering = false;
    pdfState.queuedPage = null;
    pdfState.currentBookId = null;
    pdfState.pointers.clear();
    pdfState.pinchState = null;
    pdfState.panState = null;
    if (pdfCanvasWrap) {
      pdfCanvasWrap.style.width = "0px";
      pdfCanvasWrap.style.height = "0px";
    }
    if (pdfViewer) pdfViewer.classList.remove("is-dragging");
    if (pdfCanvas) {
      const ctx = pdfCanvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, pdfCanvas.width, pdfCanvas.height);
    }
  }

  function resetEpubViewer() {
    if (epubState.rendition?.destroy) {
      epubState.rendition.destroy();
    }
    if (epubState.book?.destroy) {
      epubState.book.destroy();
    }
    epubState.book = null;
    epubState.rendition = null;
    epubState.currentBookId = null;
    if (epubViewer) epubViewer.innerHTML = "";
  }

  function schedulePdfRender() {
    if (pdfState.renderDebounce) clearTimeout(pdfState.renderDebounce);
    pdfState.renderDebounce = setTimeout(() => {
      pdfState.renderDebounce = null;
      void renderPdfPage(pdfState.page || 1);
    }, 60);
  }

  function setPdfFitMode(mode) {
    if (!pdfState.doc) return;
    pdfState.fitMode = mode;
    schedulePdfRender();
  }

  function resetPdfZoom() {
    if (!pdfState.doc) return;
    pdfState.fitMode = "custom";
    pdfState.scale = 1;
    schedulePdfRender();
  }

  function setPdfZoom(scale, { centerX, centerY } = {}) {
    if (!pdfViewer || !pdfState.doc) return;
    const rect = pdfViewer.getBoundingClientRect();
    const anchorX = typeof centerX === "number" ? centerX - rect.left : rect.width / 2;
    const anchorY = typeof centerY === "number" ? centerY - rect.top : rect.height / 2;
    const prevScale = pdfState.scale || 1;
    const nextScale = clamp(scale, 0.6, 4);
    pdfState.scale = nextScale;
    pdfState.fitMode = "custom";

    const anchorOffsetX = pdfViewer.scrollLeft + anchorX;
    const anchorOffsetY = pdfViewer.scrollTop + anchorY;
    const ratio = nextScale / prevScale;
    pdfState.pendingScroll = {
      left: anchorOffsetX * ratio - anchorX,
      top: anchorOffsetY * ratio - anchorY
    };
    schedulePdfRender();
    updatePdfControls();
  }

  function updatePdfFullscreenButton() {
    if (!pdfFullscreenBtn) return;
    const isNativeFullscreen = !!(document.fullscreenElement && pdfFullscreenTarget && document.fullscreenElement === pdfFullscreenTarget);
    pdfState.isFullscreen = isNativeFullscreen;
    const isActive = isNativeFullscreen || pdfState.isPseudoFullscreen;
    pdfFullscreenBtn.textContent = isActive ? "Exit full screen" : "Full screen";
    pdfFullscreenBtn.setAttribute("aria-label", isActive ? "Exit full screen" : "Enter full screen");
  }

  function setPdfPseudoFullscreen(enabled) {
    if (enabled) {
      document.body.classList.add("viewer-fullscreen");
      pdfState.isPseudoFullscreen = true;
    } else {
      document.body.classList.remove("viewer-fullscreen");
      pdfState.isPseudoFullscreen = false;
    }
    updatePdfFullscreenButton();
    schedulePdfRender();
  }

  function togglePdfFullscreen() {
    if (!pdfFullscreenTarget) return;
    const isNative = document.fullscreenElement && document.fullscreenElement === pdfFullscreenTarget;
    if (isNative || pdfState.isPseudoFullscreen) {
      if (isNative) {
        void document.exitFullscreen?.();
      }
      if (pdfState.isPseudoFullscreen) setPdfPseudoFullscreen(false);
      return;
    }
    if (pdfFullscreenTarget.requestFullscreen) {
      pdfFullscreenTarget.requestFullscreen().catch(() => setPdfPseudoFullscreen(true));
    } else {
      setPdfPseudoFullscreen(true);
    }
  }

  function handlePdfPointerDown(event) {
    if (!pdfViewer || !pdfState.doc) return;
    if (event.pointerType === "mouse") {
      if (event.button !== 0) return;
      pdfViewer.setPointerCapture(event.pointerId);
      pdfState.panState = {
        startX: event.clientX,
        startY: event.clientY,
        startScrollLeft: pdfViewer.scrollLeft,
        startScrollTop: pdfViewer.scrollTop
      };
      pdfViewer.classList.add("is-dragging");
      event.preventDefault();
      return;
    }

    pdfState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pdfState.pointers.size === 2) {
      const [a, b] = Array.from(pdfState.pointers.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      pdfState.pinchState = {
        initialDistance: distance,
        initialScale: pdfState.scale || 1
      };
      event.preventDefault();
    }
  }

  function handlePdfPointerMove(event) {
    if (!pdfState.doc || !pdfViewer) return;
    if (event.pointerType === "mouse" && pdfState.panState) {
      const dx = event.clientX - pdfState.panState.startX;
      const dy = event.clientY - pdfState.panState.startY;
      pdfViewer.scrollLeft = pdfState.panState.startScrollLeft - dx;
      pdfViewer.scrollTop = pdfState.panState.startScrollTop - dy;
      event.preventDefault();
      return;
    }

    if (!pdfState.pointers.has(event.pointerId)) return;
    pdfState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pdfState.pointers.size === 2 && pdfState.pinchState) {
      const [a, b] = Array.from(pdfState.pointers.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const centerX = (a.x + b.x) / 2;
      const centerY = (a.y + b.y) / 2;
      const nextScale = clamp(pdfState.pinchState.initialScale * (distance / pdfState.pinchState.initialDistance), 0.6, 4);
      setPdfZoom(nextScale, { centerX, centerY });
      event.preventDefault();
    }
  }

  function handlePdfPointerUp(event) {
    if (!pdfViewer) return;
    if (event.pointerType === "mouse") {
      if (pdfViewer.hasPointerCapture?.(event.pointerId)) {
        pdfViewer.releasePointerCapture(event.pointerId);
      }
      pdfState.panState = null;
      pdfViewer.classList.remove("is-dragging");
      return;
    }

    if (pdfState.pointers.has(event.pointerId)) {
      pdfState.pointers.delete(event.pointerId);
    }
    if (pdfState.pointers.size < 2) {
      pdfState.pinchState = null;
    }
  }

  function handlePdfWheel(event) {
    if (!pdfViewer || !pdfState.doc) return;
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const zoomFactor = Math.exp(-event.deltaY * 0.002);
    setPdfZoom((pdfState.scale || 1) * zoomFactor, {
      centerX: event.clientX,
      centerY: event.clientY
    });
  }

  function updatePdfControls() {
    if (!pdfPageInput || !pdfPageTotal) return;
    pdfPageInput.value = String(pdfState.page || 1);
    pdfPageInput.max = String(pdfState.total || 1);
    pdfPageTotal.textContent = String(pdfState.total || 1);
    if (pdfPageSlider) {
      pdfPageSlider.value = String(pdfState.page || 1);
      pdfPageSlider.max = String(pdfState.total || 1);
    }
    if (pdfFirstBtn) pdfFirstBtn.disabled = pdfState.page <= 1;
    if (pdfPrevBtn) pdfPrevBtn.disabled = pdfState.page <= 1;
    if (pdfNextBtn) pdfNextBtn.disabled = pdfState.page >= pdfState.total;
    if (pdfLastBtn) pdfLastBtn.disabled = pdfState.page >= pdfState.total;
    if (pdfZoomLabel) pdfZoomLabel.textContent = `${Math.round((pdfState.scale || 1) * 100)}%`;
  }

  async function renderPdfPage(pageNumber) {
    if (!pdfState.doc || !pdfCanvas) return;
    const target = clamp(pageNumber, 1, pdfState.total || 1);
    if (pdfState.rendering) {
      pdfState.queuedPage = target;
      return;
    }
    pdfState.rendering = true;
    setViewerStatus(`Rendering page ${target}…`);
    const page = await pdfState.doc.getPage(target);
    const unscaled = page.getViewport({ scale: 1 });
    const containerWidth = pdfViewer?.clientWidth || unscaled.width;
    const containerHeight = pdfViewer?.clientHeight || unscaled.height;
    const widthScale = containerWidth ? (containerWidth - 16) / unscaled.width : 1;
    const heightScale = containerHeight ? (containerHeight - 16) / unscaled.height : 1;
    let fitScale = widthScale;
    if (pdfState.fitMode === "page") {
      fitScale = Math.min(widthScale, heightScale);
    }
    if (pdfState.fitMode === "custom") {
      fitScale = clamp(pdfState.scale || 1, 0.6, 4);
    }
    const qualityBoost = (pdfState.isFullscreen || pdfState.isPseudoFullscreen) ? 1.2 : 1;
    const renderScale = fitScale * qualityBoost;
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: renderScale * outputScale });
    const cssViewport = page.getViewport({ scale: renderScale });
    const ctx = pdfCanvas.getContext("2d");
    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;
    pdfCanvas.style.width = `${cssViewport.width}px`;
    pdfCanvas.style.height = `${cssViewport.height}px`;
    if (pdfCanvasWrap) {
      pdfCanvasWrap.style.width = `${cssViewport.width}px`;
      pdfCanvasWrap.style.height = `${cssViewport.height}px`;
    }
    await page.render({ canvasContext: ctx, viewport }).promise;
    pdfState.fitScale = fitScale;
    pdfState.renderScale = renderScale;
    pdfState.canvasWidth = cssViewport.width;
    pdfState.canvasHeight = cssViewport.height;
    pdfState.page = target;
    pdfState.scale = fitScale;
    pdfState.rendering = false;
    updatePdfControls();
    setViewerStatus(`Page ${pdfState.page} / ${pdfState.total}`);
    if (pdfState.pendingScroll && pdfViewer) {
      pdfViewer.scrollLeft = pdfState.pendingScroll.left;
      pdfViewer.scrollTop = pdfState.pendingScroll.top;
      pdfState.pendingScroll = null;
    }

    if (pdfState.queuedPage && pdfState.queuedPage !== target) {
      const next = pdfState.queuedPage;
      pdfState.queuedPage = null;
      void renderPdfPage(next);
    }
  }

  async function loadPdfForBook(book) {
    if (!book || !pdfCanvas) return;
    const content = contentCache.get(book.id);
    if (!content?.fileData) {
      setViewerStatus("No PDF data stored for this book.");
      return;
    }
    if (pdfState.currentBookId === book.id && pdfState.doc) {
      updatePdfControls();
      return;
    }
    resetPdfViewer();
    try {
      const pdfjsLib = window["pdfjs-dist/build/pdf"];
      if (!pdfjsLib) {
        setViewerStatus("PDF viewer unavailable.");
        return;
      }
      pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      setViewerStatus("Loading PDF…");
      const loadingTask = pdfjsLib.getDocument({ data: content.fileData });
      pdfState.doc = await loadingTask.promise;
      pdfState.total = pdfState.doc.numPages || 1;
      pdfState.currentBookId = book.id;
      pdfState.fitMode = "width";
      pdfState.scale = 1;
      const desiredPage = clamp(book.readerState?.currentPdfPage ?? 1, 1, pdfState.total);
      await renderPdfPage(desiredPage);
    } catch (err) {
      console.error("PDF load failed", err);
      setViewerStatus("Failed to load PDF.");
      showToast({ title: "PDF load failed", message: "Try re-importing the file.", type: "error" });
    }
  }

  async function loadEpubForBook(book) {
    if (!book) return;
    const content = contentCache.get(book.id);
    if (!content?.fileData || !epubViewer) {
      setViewerStatus("No EPUB data stored for this book.");
      return;
    }
    if (epubState.currentBookId === book.id && epubState.rendition) {
      return;
    }
    resetEpubViewer();
    try {
      const epubLib = window.ePub;
      if (!epubLib) {
        setViewerStatus("EPUB viewer unavailable.");
        return;
      }
      if (!window.JSZip) {
        setViewerStatus("EPUB support missing (JSZip not loaded).");
        showToast({ title: "EPUB support missing", message: "JSZip is required to open EPUB files.", type: "error" });
        return;
      }
      setViewerStatus("Loading EPUB…");
      epubState.book = epubLib(content.fileData);
      await epubState.book.ready;
      epubState.rendition = epubState.book.renderTo(epubViewer, { width: "100%", height: "60vh" });
      await epubState.rendition.display();
      epubState.currentBookId = book.id;
      setViewerStatus("EPUB loaded.");
    } catch (err) {
      console.error("EPUB load failed", err);
      setViewerStatus("Failed to load EPUB.");
      showToast({ title: "EPUB load failed", message: "Try re-importing the file.", type: "error" });
    }
  }

  function setPdfPage(page, { userInitiated = false, fromRsvpSync = false } = {}) {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book || book.sourceType !== "pdf") return;
    if (!pdfState.doc) return;
    const clampedPage = clamp(page, 1, pdfState.total || 1);
    void renderPdfPage(clampedPage);
    if (book.readerState?.currentPdfPage !== clampedPage) {
      updateBookReaderState(book.id, { currentPdfPage: clampedPage });
    }
    if (userInitiated && syncRsvpToggle?.checked && !fromRsvpSync) {
      syncRsvpToPdfPage(clampedPage, { userInitiated: true });
    }
  }

  function jumpPdfPage(delta) {
    setPdfPage((pdfState.page || 1) + delta, { userInitiated: true });
  }

  function adjustPdfZoom(delta) {
    setPdfZoom((pdfState.scale || 1) + delta);
  }

  function schedulePdfSync(page) {
    if (!page || !pdfState.doc) return;
    if (!selectedBookId || pdfState.currentBookId !== selectedBookId) return;
    if (pdfState.page === page) return;
    pdfSyncTarget = page;
    if (pdfSyncTimer) return;
    pdfSyncTimer = setTimeout(() => {
      pdfSyncTimer = null;
      const next = pdfSyncTarget;
      pdfSyncTarget = null;
      if (typeof next !== "number") return;
      setPdfPage(next, { userInitiated: false, fromRsvpSync: true });
    }, 140);
  }

  function syncRsvpToPdfPage(page, { userInitiated = false } = {}) {
    if (!selectedBookId) return;
    const book = getBook(selectedBookId);
    if (!book) return;
    const wordStart = getWordStartForPdfPage(book.id, page);
    const tokenIndex = getTokenIndexForWordIndex(book.id, wordStart);
    if (reader.isPlaying) stopReader(false);
    setTokenIndex(tokenIndex, { fromPlayback: false, syncPageView: !userInitiated });
  }

  async function renderDocumentViewer(book) {
    if (!documentViewer || !pageView) return;
    if (!book) {
      showViewerType("empty");
      setViewerStatus("Select a book to view pages.");
      if (pageView) pageView.innerHTML = "<p class=\"subtle\">Select a book to start reading.</p>";
      return;
    }

    if (book.sourceType === "pdf") {
      resetEpubViewer();
      showViewerType("pdf");
      setViewerStatus("Preparing PDF…");
      pageViewBookId = null;
      await loadPdfForBook(book);
      return;
    }

    if (book.sourceType === "epub") {
      resetPdfViewer();
      showViewerType("epub");
      pageViewBookId = null;
      await loadEpubForBook(book);
      return;
    }

    resetPdfViewer();
    resetEpubViewer();
    showViewerType("text");
    if (pageViewBookId !== book.id || !pageMapCache.has(book.id)) {
      renderPageView(book);
      pageViewBookId = book.id;
    }
  }

  function renderPageView(book) {
    if (!pageView || !pageProgress) return;
    if (!book) {
      pageView.innerHTML = "<p class=\"subtle\">Select a book to start reading.</p>";
      pageProgress.textContent = "0% • word 0 / 0";
      return;
    }
    const tokens = getCachedTokens(book.id);
    if (!tokens.length) {
      pageView.innerHTML = "<p class=\"subtle\">Loading text…</p>";
      pageProgress.textContent = "0% • word 0 / 0";
      return;
    }

    const paragraphs = buildPageMap(book.id);
    if (!paragraphs.length) {
      pageView.innerHTML = "<p class=\"subtle\">No readable text found.</p>";
      return;
    }

    pageView.innerHTML = "";
    const fragment = document.createDocumentFragment();
    paragraphs.forEach((para, idx) => {
      const p = document.createElement("p");
      p.textContent = para.text;
      p.dataset.index = String(idx);
      fragment.appendChild(p);
    });
    pageView.appendChild(fragment);
    updateProgressUI(book);
  }

  /* ---------------------------
     Reader logic
  --------------------------- */
  function isNarrowReaderLayout() {
    return window.matchMedia("(max-width: 1100px)").matches;
  }

  function initReaderMode() {
    if (!state.settings.readerMode) {
      state.settings.readerMode = isNarrowReaderLayout() ? "page" : "rsvp";
      saveState();
    }
    setReaderMode(state.settings.readerMode, { persist: false });
  }

  function setReaderMode(mode, { persist = true } = {}) {
    if (!["page", "rsvp"].includes(mode)) return;
    const readerView = $("#view-reader");
    if (readerView) readerView.dataset.readerMode = mode;
    if (persist) {
      state.settings.readerMode = mode;
      saveState();
    }
  }

  function restoreLastBookIfNeeded() {
    if (!state.settings.rememberLastBook) return;
    const lastId = state.reader?.currentBookId || state.library.lastOpenedBookId || state.lastOpenedBookId;
    if (!lastId) return;
    const b = getBook(lastId);
    if (!b) return;
    // Don't auto-switch view; just preload the book selection for quick start
    selectedBookId = b.id;
    void ensureBookContent(b.id).then(() => renderReader());
  }

  async function openBookInReader(bookId) {
    const book = getBook(bookId);
    if (!book) return;

    // Stop current playback
    stopReader(true);

    selectedBookId = book.id;
    state.reader.currentBookId = book.id;
    if (state.settings.rememberLastBook) {
      state.library.lastOpenedBookId = book.id;
      state.lastOpenedBookId = book.id;
    }

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
    const bookWpm = book.readerState?.wpm ?? state.settings.defaultWpm ?? 300;
    const bookPause = book.readerState?.pause ?? state.settings.punctuationPause ?? 80;
    if (wpmSlider) wpmSlider.value = String(bookWpm);
    if (pauseSlider) pauseSlider.value = String(bookPause);
    if (wpmValue) wpmValue.textContent = String(bookWpm);
    if (syncRsvpToggle) syncRsvpToggle.checked = !!book.readerState?.syncRsvpToPage;

    // Ensure content ready
    renderReaderLoading();
    await ensureBookContent(book.id);

    // Render
    renderReader();
    renderReaderNotes();
    renderNotesView();
    renderLibraryList();
  }

  function renderReader() {
    const book = selectedBookId ? getBook(selectedBookId) : null;

    if (!book) {
      if (readerBookTitle) readerBookTitle.textContent = "No book selected";
      if (readerBookSub) readerBookSub.textContent = "Choose a book from Library";
      setRSVPDisplay("Ready", "•", "Set");
      if (readerProgressEl) readerProgressEl.textContent = "0%";
      if (rsvpSubline) {
        rsvpSubline.textContent = "Select a book, then tap Play to start.";
        rsvpSubline.hidden = false;
      }
      if (btnPlay) btnPlay.disabled = true;
      pageViewBookId = null;
      void renderDocumentViewer(null);
      updateProgressUI(null);
      renderReaderBookmarks();
      return;
    }

    if (btnPlay) btnPlay.disabled = false;
    if (readerBookTitle) readerBookTitle.textContent = book.title || "Untitled";
    if (readerBookSub) readerBookSub.textContent = `${book.author || "—"} • ${book.wordCount || 0} words`;
    if (syncRsvpToggle) syncRsvpToggle.checked = !!book.readerState?.syncRsvpToPage;

    const tokens = getCachedTokens(book.id);
    if (!tokens.length) {
      const cached = contentCache.get(book.id);
      if (cached && (!cached.tokens || cached.tokens.length === 0)) {
        if (readerBookSub) readerBookSub.textContent = "No readable text found.";
        setRSVPDisplay("No", "•", "Text");
        if (rsvpSubline) {
          rsvpSubline.textContent = "Try another file or source";
          rsvpSubline.hidden = false;
        }
        if (btnPlay) btnPlay.disabled = true;
        void renderDocumentViewer(book);
        return;
      }
      renderReaderLoading();
      void ensureBookContent(book.id).then(() => renderReader());
      return;
    }

    // Render current token
    const idx = clamp(book.progress?.index ?? 0, 0, Math.max(0, tokens.length - 1));
    renderTokenAtIndex(book, idx);
    updateProgressUI(book);
    renderReaderBookmarks();
    void renderDocumentViewer(book);
    if (!reader.isPlaying && rsvpSubline) {
      if (idx >= tokens.length - 1) {
        rsvpSubline.textContent = "End of book";
      } else {
        rsvpSubline.textContent = book.sourceType === "pdf"
          ? "Press Play to start. Tip: tap the PDF to jump."
          : "Press Play to start from your last position.";
      }
      rsvpSubline.hidden = false;
    }
  }

  function renderReaderLoading() {
    if (readerBookTitle) readerBookTitle.textContent = "Loading…";
    if (readerBookSub) readerBookSub.textContent = "Preparing book text";
    setRSVPDisplay("Loading", "•", "Book");
    if (rsvpSubline) {
      rsvpSubline.textContent = "Please wait";
      rsvpSubline.hidden = false;
    }
    if (btnPlay) btnPlay.disabled = true;
    if (pageView) {
      pageView.innerHTML = "<p class=\"subtle\">Loading text…</p>";
    }
    if (pageProgress) pageProgress.textContent = "0% • word 0 / 0";
    setViewerStatus("Preparing document…");
  }

  function updateProgressUI(book) {
    if (!readerProgressEl || !progressLabel || !progressSlider || !pageProgress) return;
    if (!book) {
      readerProgressEl.textContent = "0%";
      progressLabel.textContent = "0% • word 0 / 0";
      pageProgress.textContent = "0% • word 0 / 0";
      progressSlider.value = "0";
      progressSlider.max = "0";
      return;
    }

    const totalWords = Math.max(0, getTotalWordsForBook(book));
    const tokenIndex = clamp(book.progress?.index ?? 0, 0, Math.max(0, getTokenCountForBook(book) - 1));
    const wordIndex = totalWords ? getWordIndexForTokenIndex(book.id, tokenIndex) : 0;
    const pct = computeProgressPct(book);
    readerProgressEl.textContent = `${pct}%`;
    const label = `${pct}% • word ${totalWords ? wordIndex + 1 : 0} / ${totalWords || 0}`;
    progressLabel.textContent = label;
    pageProgress.textContent = label;

    if (!scrubberActive) {
      progressSlider.max = String(Math.max(0, totalWords - 1));
      progressSlider.value = String(Math.min(wordIndex, Math.max(0, totalWords - 1)));
    }
  }

  function scheduleScrub(value, commit) {
    pendingScrubValue = { value, commit };
    if (scrubberRaf) return;
    scrubberRaf = requestAnimationFrame(() => {
      const pending = pendingScrubValue;
      scrubberRaf = null;
      pendingScrubValue = null;
      if (!pending) return;
      applyScrub(pending.value, pending.commit);
    });
  }

  function applyScrub(wordIndex, commit) {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;
    const totalWords = Math.max(1, getTotalWordsForBook(book));
    const clamped = clamp(wordIndex, 0, Math.max(0, totalWords - 1));
    const tokenIndex = getTokenIndexForWordIndex(book.id, clamped);
    setTokenIndex(tokenIndex, { fromPlayback: false, syncPageView: true });
    if (commit && isNarrowReaderLayout()) setReaderMode("rsvp");
  }

  function scrollPageViewToTokenIndex(book, tokenIndex, behavior = "smooth") {
    if (!pageView || !book) return;
    const paragraphs = buildPageMap(book.id);
    if (!paragraphs.length) return;
    const target = paragraphs.findIndex(p => tokenIndex >= p.startTokenIndex && tokenIndex <= p.endTokenIndex);
    if (target < 0) return;
    const targetEl = pageView.querySelector(`p[data-index="${target}"]`);
    if (targetEl) {
      targetEl.scrollIntoView({ behavior, block: "center", inline: "nearest" });
    }
  }

  function setRSVPDisplay(left, pivot, right) {
    if (rsvpLeft) rsvpLeft.textContent = left;
    if (rsvpPivot) rsvpPivot.textContent = pivot;
    if (rsvpRight) rsvpRight.textContent = right;
    scheduleRsvpFit();
  }

  function scheduleRsvpFit() {
    if (!rsvpFrame || !$("#rsvp-word")) return;
    requestAnimationFrame(() => fitRsvpWord());
  }

  function fitRsvpWord() {
    const rsvpWord = $("#rsvp-word");
    if (!rsvpFrame || !rsvpWord) return;
    const baseSize = clamp(Number(state.settings.fontSize || 46), 22, 72);
    const style = getComputedStyle(rsvpFrame);
    const baseLeft = parseFloat(style.getPropertyValue("--maxLeft")) || 14;
    const baseRight = parseFloat(style.getPropertyValue("--maxRight")) || 20;

    let size = baseSize;
    let left = baseLeft;
    let right = baseRight;

    const apply = () => {
      rsvpWord.style.fontSize = `${size}px`;
      rsvpFrame.style.setProperty("--rsvpMaxLeft", `${left}ch`);
      rsvpFrame.style.setProperty("--rsvpMaxRight", `${right}ch`);
    };

    apply();
    let frameRect = rsvpFrame.getBoundingClientRect();
    let wordRect = rsvpWord.getBoundingClientRect();
    let attempts = 0;

    while (wordRect.width > frameRect.width - 8 && attempts < 4) {
      size = Math.max(baseSize - 8, size - 2);
      left = Math.max(6, left - 1);
      right = Math.max(8, right - 1);
      apply();
      frameRect = rsvpFrame.getBoundingClientRect();
      wordRect = rsvpWord.getBoundingClientRect();
      attempts += 1;
    }

    if (wordRect.width <= frameRect.width - 8 && attempts === 0) {
      rsvpWord.style.fontSize = `${baseSize}px`;
      rsvpFrame.style.setProperty("--rsvpMaxLeft", `${baseLeft}ch`);
      rsvpFrame.style.setProperty("--rsvpMaxRight", `${baseRight}ch`);
    }
  }

  function renderTokenAtIndex(book, idx) {
    const tokens = getCachedTokens(book.id);
    const tok = tokens[idx];
    if (!tok) {
      setRSVPDisplay("End", "•", "Done");
      if (rsvpSubline) {
        rsvpSubline.textContent = "End of book";
        rsvpSubline.hidden = false;
      }
      stopReader(true);
      return;
    }

    if (reader.chunkDisplay && reader.chunkDisplay.endIndex === idx) {
      const words = reader.chunkDisplay.words || [];
      const [first, ...rest] = words;
      const { left, pivot, right } = renderRSVPWord(first || "");
      const restText = rest.length ? ` ${rest.join(" ")}` : "";
      setRSVPDisplay(left, pivot, `${right}${restText}`);
      if (rsvpSubline) rsvpSubline.hidden = true;
      return;
    }

    if (tok.kind === "para") {
      // Show a short pause token
      setRSVPDisplay("", "¶", "");
      if (rsvpSubline) {
        rsvpSubline.textContent = "Paragraph";
        rsvpSubline.hidden = false;
      }
      return;
    }

    if (tok.kind === "punct") {
      setRSVPDisplay("", tok.t, "");
      if (rsvpSubline) {
        rsvpSubline.textContent = "Punctuation";
        rsvpSubline.hidden = true;
      }
      return;
    }

    // Word
    const { left, pivot, right } = renderRSVPWord(tok.t);
    setRSVPDisplay(left, pivot, right);
    if (rsvpSubline) rsvpSubline.hidden = true;
  }

  function getCurrentTokenIndex() {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return 0;
    const total = Math.max(0, getTokenCountForBook(book));
    return clamp(book.progress?.index ?? 0, 0, Math.max(0, total - 1));
  }

  function setTokenIndex(idx, { fromPlayback = false, syncPageView = false } = {}) {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;
    if (!fromPlayback) reader.chunkDisplay = null;

    const total = Math.max(0, getTokenCountForBook(book));
    const clamped = clamp(idx, 0, Math.max(0, total - 1));
    const wordIndex = getWordIndexForTokenIndex(book.id, clamped);
    const wpmSetting = Number(wpmSlider?.value || book.readerState?.wpm || state.settings.defaultWpm || 300);
    const pauseSetting = Number(pauseSlider?.value || book.readerState?.pause || state.settings.punctuationPause || 80);
    const nextPdfPage = book.sourceType === "pdf"
      ? getPdfPageForWordIndex(book.id, wordIndex)
      : (book.readerState?.currentPdfPage || 1);
    const updated = {
      ...book,
      progress: {
        ...book.progress,
        index: clamped,
        updatedAt: nowISO()
      },
      readerState: {
        ...book.readerState,
        currentWordIndex: wordIndex,
        currentPdfPage: nextPdfPage,
        wpm: wpmSetting,
        pause: pauseSetting
      },
      stats: {
        ...book.stats,
        lastSessionAt: nowISO()
      }
    };

    // Track read words for session / total
    if (fromPlayback) {
      const tok = getCachedTokens(book.id)[clamped];
      if (tok && tok.kind === "word") {
        updated.stats.totalReadWords = (updated.stats.totalReadWords || 0) + 1;
      }
    }

    upsertBook(updated);
    renderReader();
    renderLibraryList();

    if (syncPageView && !reader.isPlaying) {
      scrollPageViewToTokenIndex(book, clamped, "auto");
    }
    if (book.sourceType === "pdf" && getPageRangesForBook(book.id).length) {
      schedulePdfSync(nextPdfPage);
    }
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
    const tokens = getCachedTokens(book.id);
    if (!tokens.length) {
      renderReaderLoading();
      void ensureBookContent(book.id).then(() => startReader());
      return;
    }

    reader.isPlaying = true;
    reader.chunkDisplay = null;
    btnPlay?.setAttribute("aria-pressed", "true");
    if (btnPlay) btnPlay.textContent = "⏸ Pause";
    if (rsvpSubline) rsvpSubline.hidden = true;
    void requestWakeLock();

    // Start session timer
    if (!reader.startedAt) {
      reader.startedAt = Date.now();
      reader.elapsedBefore = 0;
      reader.sessionWords = 0;
      reader.pauses = 0;
      if (statAvgWpm) statAvgWpm.textContent = "—";
      if (statPauses) statPauses.textContent = "0";
      if (statWords) statWords.textContent = "0";
    } else {
      // resume
      reader.startedAt = Date.now();
    }

    // Kick tick loop
    reader.nextTickAt = performance.now();
    scheduleNextTick(0);
    scheduleSessionUI();
  }

  function stopReader(hardStop) {
    if (reader.timer) {
      clearTimeout(reader.timer);
      reader.timer = null;
    }

    if (reader.isPlaying) {
      // accumulate elapsed
      const elapsed = Date.now() - (reader.startedAt || Date.now());
      reader.elapsedBefore += elapsed;
    }

    reader.isPlaying = false;
    reader.nextTickAt = null;
    reader.chunkDisplay = null;
    btnPlay?.setAttribute("aria-pressed", "false");
    if (btnPlay) btnPlay.textContent = "▶ Play";
    void releaseWakeLock();

    if (hardStop) {
      reader.startedAt = null;
      reader.elapsedBefore = 0;
      reader.sessionWords = 0;
      reader.pauses = 0;
      if (statSession) statSession.textContent = "00:00";
      if (statWords) statWords.textContent = "0";
      if (statAvgWpm) statAvgWpm.textContent = "—";
      if (statPauses) statPauses.textContent = "0";
    }
  }

  function scheduleSessionUI() {
    // Update session stats periodically while playing
    const tick = () => {
      if (!reader.isPlaying) return;
      const elapsed = reader.elapsedBefore + (Date.now() - (reader.startedAt || Date.now()));
      if (statSession) statSession.textContent = formatMs(elapsed);

      // Avg WPM
      const minutes = elapsed / 60000;
      if (minutes > 0.05) {
        const avg = Math.round(reader.sessionWords / minutes);
        if (statAvgWpm) statAvgWpm.textContent = String(avg);
      }

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function getBaseDelayMs() {
    const baseWpm = clamp(Number(wpmSlider.value || state.settings.defaultWpm || 300), 150, 1200);
    return 60000 / baseWpm;
  }

  function getPauseKindForWord(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return null;
    const cleaned = trimmed.replace(TRAILING_WRAPPER_RE, "");
    if (HARD_PUNCT_WORD_RE.test(cleaned)) return "hard";
    if (SOFT_PUNCT_WORD_RE.test(cleaned)) return "soft";
    return null;
  }

  function getPauseInfoForToken(tok) {
    if (!state.settings.autoPause || !tok) return { extraDelay: 0, countPause: false };
    const pauseSliderValue = clamp(Number(pauseSlider.value ?? state.settings.punctuationPause ?? 80), 0, 200);
    const pauseScale = pauseSliderValue / 100;
    const baseDelay = getBaseDelayMs();
    const maxExtra = baseDelay * 2;

    if (tok.kind === "para") {
      const extraDelay = Math.min(baseDelay * 1.2 * pauseScale, maxExtra);
      return { extraDelay, countPause: extraDelay > 0 };
    }
    if (tok.kind === "punct") {
      if (HARD_PUNCT_RE.test(tok.t)) {
        const extraDelay = Math.min(baseDelay * 0.8 * pauseScale, maxExtra);
        return { extraDelay, countPause: extraDelay > 0 };
      }
      if (SOFT_PUNCT_RE.test(tok.t)) {
        const extraDelay = Math.min(baseDelay * 0.35 * pauseScale, maxExtra);
        return { extraDelay, countPause: extraDelay > 0 };
      }
    }
    if (tok.kind === "word") {
      const pauseKind = getPauseKindForWord(tok.t);
      if (pauseKind === "hard") {
        const extraDelay = Math.min(baseDelay * 0.8 * pauseScale, maxExtra);
        return { extraDelay, countPause: extraDelay > 0 };
      }
      if (pauseKind === "soft") {
        const extraDelay = Math.min(baseDelay * 0.35 * pauseScale, maxExtra);
        return { extraDelay, countPause: extraDelay > 0 };
      }
    }
    return { extraDelay: 0, countPause: false };
  }

  function scheduleNextTick(extraDelayMs) {
    if (!reader.isPlaying) return;
    const baseInterval = getBaseDelayMs();
    const delay = Math.max(0, baseInterval + (extraDelayMs || 0));
    const now = performance.now();
    reader.nextTickAt = reader.nextTickAt ? reader.nextTickAt + delay : now + delay;
    const timeout = Math.max(0, reader.nextTickAt - now);
    reader.timer = setTimeout(advancePlayback, timeout);
  }

  function advancePlayback() {
    if (!reader.isPlaying) return;

    const book = getBook(selectedBookId);
    if (!book) return stopReader(true);

    const tokens = getCachedTokens(book.id);
    let idx = getCurrentTokenIndex();
    if (idx >= tokens.length) {
      stopReader(true);
      return;
    }

    // Move to next meaningful token (including punctuation/para, but with pauses)
    idx = clamp(idx + 1, 0, Math.max(0, tokens.length - 1));
    let tok = tokens[idx];
    const chunkSize = clamp(Number(state.settings.chunkSize || 1), 1, 4);
    reader.chunkDisplay = null;

    if (tok && tok.kind === "word" && chunkSize > 1) {
      const chunkInfo = getChunkInfo(tokens, idx, chunkSize);
      if (chunkInfo) {
        reader.chunkDisplay = chunkInfo;
        idx = chunkInfo.endIndex;
        tok = tokens[idx];
      }
    }

    // If we just advanced into a word, count it for session
    if (tok && tok.kind === "word") {
      const chunkWords = reader.chunkDisplay?.wordCount || 1;
      reader.sessionWords += chunkWords;
      if (statWords) statWords.textContent = String(reader.sessionWords);
    }

    // Render token
    setTokenIndex(idx, { fromPlayback: tok?.kind === "word" });

    // Compute pause
    const pauseInfo = getPauseInfoForToken(tok);
    const extra = pauseInfo.extraDelay;
    if (pauseInfo.countPause) {
      reader.pauses += 1;
      if (statPauses) statPauses.textContent = String(reader.pauses);
    }

    // If at end, stop soon
    if (idx >= tokens.length - 1) {
      // show last token then stop
      scheduleNextTick(extra + getBaseDelayMs());
      setTimeout(() => stopReader(true), extra + 250);
      return;
    }

    scheduleNextTick(extra);
  }

  function getChunkInfo(tokens, startIndex, chunkSize) {
    if (!tokens || !tokens.length) return null;
    const words = [];
    let endIndex = startIndex;
    for (let i = startIndex; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (!tok) break;
      if (tok.kind !== "word") break;
      words.push(tok.t);
      endIndex = i;
      if (words.length >= chunkSize) break;
    }
    if (!words.length) return null;
    return {
      startIndex,
      endIndex,
      words,
      wordCount: words.length
    };
  }

  function stepWords(delta) {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;

    // Pause on manual stepping (but don't hard reset session)
    if (reader.isPlaying) stopReader(false);

    const idx = getCurrentTokenIndex();
    const tokens = getCachedTokens(book.id);
    if (!tokens.length) return;
    const next = clamp(idx + delta, 0, Math.max(0, tokens.length - 1));
    setTokenIndex(next, { fromPlayback: false, syncPageView: true });
    renderReader();
    renderReaderNotes();
  }

  function stepSentence(dir) {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;

    if (reader.isPlaying) stopReader(false);

    const idx = getCurrentTokenIndex();
    const tokens = getCachedTokens(book.id);

    function isSentenceEnd(i) {
      const t = tokens[i];
      if (!t) return false;
      if (t.kind === "punct") return HARD_PUNCT_RE.test(t.t);
      if (t.kind === "word") {
        const cleaned = (t.t || "").replace(TRAILING_WRAPPER_RE, "");
        return HARD_PUNCT_WORD_RE.test(cleaned);
      }
      return false;
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

    setTokenIndex(target, { fromPlayback: false, syncPageView: true });
    renderReader();
    renderReaderNotes();
  }

  function bumpWpm(delta) {
    const cur = clamp(Number(wpmSlider?.value || 300), 150, 1200);
    const next = clamp(cur + delta, 150, 1200);
    if (wpmSlider) wpmSlider.value = String(next);
    if (wpmValue) wpmValue.textContent = String(next);
    state.settings.defaultWpm = next;
    saveState();
  }

  function addBookmark() {
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) return;

    const idx = getCurrentTokenIndex();
    const wordIndex = getWordIndexForTokenIndex(book.id, idx);
    const bm = {
      id: uid("bm"),
      index: idx,
      wordIndex,
      createdAt: nowISO(),
      snippet: makeExcerpt(book, idx, 8)
    };
    const updated = {
      ...book,
      progress: {
        ...book.progress,
        bookmarks: [bm, ...(book.progress.bookmarks || [])]
      },
      updatedAt: nowISO()
    };
    upsertBook(updated);
    renderReaderBookmarks();

    showToast({ title: "Bookmark saved", message: "You can return to this spot anytime.", type: "success" });
  }

  function openAddNoteFromReader() {
    // Focus note box and prefill with excerpt if empty
    if (!selectedBookId) return;
    const book = getBook(selectedBookId);
    const idx = getCurrentTokenIndex();
    const excerpt = makeExcerpt(book, idx, 12);

    if (!quickNote.value.trim()) {
      quickNote.value = `(${excerpt})\n`;
    }
    quickNote.focus();
  }

  function makeExcerpt(book, idx, radius = 12) {
    if (!book) return "";
    // Build a short excerpt around idx using only word tokens
    const tokens = getCachedTokens(book.id);
    if (!tokens.length) return "";
    const words = [];
    let i = idx;
    // Step back a bit
    let back = 0;
    while (i > 0 && back < radius) {
      i--;
      if (tokens[i]?.kind === "word") {
        words.unshift(tokens[i].t);
        back++;
      }
    }
    // include current and forward
    let f = idx;
    let forward = 0;
    while (f < tokens.length && forward < radius) {
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
  function getUniqueNotes(notes = state.notes) {
    const seen = new Set();
    const unique = [];
    for (const note of notes) {
      if (!note || !note.id || seen.has(note.id)) continue;
      seen.add(note.id);
      unique.push(note);
    }
    return unique;
  }

  function renderReaderNotes() {
    const bookId = selectedBookId;
    if (!noteList) return;
    noteList.innerHTML = "";

    if (!bookId) return;

    const notes = getUniqueNotes()
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

  function renderReaderBookmarks() {
    if (!bookmarkList || !bookmarkEmpty) return;
    bookmarkList.innerHTML = "";
    const book = selectedBookId ? getBook(selectedBookId) : null;
    if (!book) {
      bookmarkEmpty.hidden = false;
      return;
    }
    const bookmarks = Array.isArray(book.progress?.bookmarks) ? book.progress.bookmarks : [];
    if (!bookmarks.length) {
      bookmarkEmpty.hidden = false;
      return;
    }
    bookmarkEmpty.hidden = true;

    bookmarks.slice(0, 20).forEach(bm => {
      const li = document.createElement("li");
      li.className = "bookmark-item";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bookmark-button";
      const wordIndex = typeof bm.wordIndex === "number"
        ? bm.wordIndex
        : getWordIndexForTokenIndex(book.id, bm.index ?? 0);
      const pct = computeProgressPct({ ...book, progress: { ...book.progress, index: bm.index ?? 0 } });
      const meta = document.createElement("div");
      meta.className = "bookmark-meta";
      meta.textContent = `${pct}% • word ${wordIndex + 1}`;
      const snippet = document.createElement("div");
      snippet.textContent = bm.snippet || makeExcerpt(book, bm.index ?? 0, 10) || "Saved location";
      button.appendChild(meta);
      button.appendChild(snippet);
      button.addEventListener("click", () => {
        if (reader.isPlaying) stopReader(false);
        setTokenIndex(bm.index ?? 0, { fromPlayback: false, syncPageView: true });
        if (isNarrowReaderLayout()) setReaderMode("rsvp");
      });
      li.appendChild(button);
      bookmarkList.appendChild(li);
    });
  }

  function renderNotesView() {
    if (!notesFilterBook || !notesAllList || !notesEmpty) return;
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
    const q = (notesSearch?.value || "").trim().toLowerCase();
    const bookFilter = notesFilterBook.value || "all";
    const sort = notesSort.value || "recent";

    let notes = [...getUniqueNotes()];
    if (bookFilter !== "all") notes = notes.filter(n => n.bookId === bookFilter);
    if (q) {
      notes = notes.filter(n => {
        const hay = `${n.text || ""} ${n.bookTitle || ""} ${n.excerpt || ""}`.toLowerCase();
        return hay.includes(q);
      });
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
      const excerpt = n.excerpt ? ` • “… ${n.excerpt.slice(0, 80)} …”` : "";
      s.textContent = `${n.bookTitle || "—"} • ${new Date(n.updatedAt || n.createdAt).toLocaleString()}${excerpt}`;

      li.appendChild(t);
      li.appendChild(s);

      li.addEventListener("click", () => void selectNote(n.id));
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void selectNote(n.id);
      });

      notesAllList.appendChild(li);
    });

    // If selected note disappeared, clear preview
    if (selectedNoteId && !state.notes.find(n => n.id === selectedNoteId)) {
      selectedNoteId = null;
      clearNotePreview();
    } else if (selectedNoteId) {
      // Keep preview updated
      void selectNote(selectedNoteId, true);
    }
  }

  async function selectNote(noteId, silent = false) {
    const note = state.notes.find(n => n.id === noteId);
    if (!note) return;
    if (!notePreviewBook || !notePreviewText || !noteEdit) return;
    selectedNoteId = noteId;

    const noteWordIndex = typeof note.wordIndex === "number"
      ? note.wordIndex
      : getWordIndexForTokenIndex(note.bookId, note.index ?? 0);
    notePreviewBook.textContent = `${note.bookTitle || "—"} • at word ${noteWordIndex + 1}`;
    notePreviewText.textContent = note.text;
    noteEdit.value = note.text;

    if (!silent) {
      // Also open the related book and jump to note location
      const book = getBook(note.bookId);
      if (book) {
        await openBookInReader(book.id);
        setView("reader");
        stepWords(0); // re-render
        const tokenIndex = typeof note.index === "number"
          ? note.index
          : getTokenIndexForWordIndex(note.bookId, noteWordIndex);
        setTokenIndex(tokenIndex, { fromPlayback: false, syncPageView: true });
        renderReaderNotes();
      }
    }
  }

  function clearNotePreview() {
    if (notePreviewBook) notePreviewBook.textContent = "—";
    if (notePreviewText) notePreviewText.textContent = "Select a note to view/edit.";
    if (noteEdit) noteEdit.value = "";
  }

  /* ---------------------------
     Export / Import
  --------------------------- */
  async function exportData() {
    const books = state.library.books.map(b => normalizeBook(b));
    const notes = idbReady ? await idbGetAll(DB_STORES.notes) : state.notes;
    let contents = [];
    if (idbReady) {
      contents = await idbGetAll(DB_STORES.contents);
    } else {
      contents = books
        .filter(b => b.text || (b.tokens && b.tokens.length))
        .map(b => ({
          bookId: b.id,
          rawText: b.text || "",
          tokens: b.tokens || [],
          tokenCount: (b.tokens || []).length,
          updatedAt: b.updatedAt || nowISO()
        }));
    }

    const safeContents = contents.map(content => ({
      ...content,
      fileData: null
    }));

    const payload = {
      exportedAt: nowISO(),
      app: "SwiftReader",
      version: CURRENT_SCHEMA_VERSION,
      settings: state.settings,
      reader: state.reader,
      books,
      contents: safeContents,
      notes
    };

    const serialized = safeStringifyJSON(payload, "export data");
    if (!serialized) return;
    const blob = new Blob([serialized], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `swiftreader-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast({ title: "Export ready", message: "Your data download has started.", type: "success" });
  }

  function importData(triggerBtn) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      setButtonLoading(triggerBtn, true, "Importing…");
      const file = input.files?.[0];
      if (!file) {
        setButtonLoading(triggerBtn, false);
        return;
      }
      try {
        const text = await fileToTextAsync(file);
        const parsed = safeParseJSON(text, null, "import file");
        if (!parsed || typeof parsed !== "object") {
          showToast({ title: "Invalid file", message: "This JSON file could not be read.", type: "error" });
          return;
        }
        const imported = parsed.state ? parsed.state : parsed;
        const migratedImport = migrateState(imported);
        const incomingBooks = Array.isArray(migratedImport.library?.books) ? migratedImport.library.books : [];
        const incomingNotes = Array.isArray(migratedImport.notes) ? migratedImport.notes : [];
        const incomingContents = Array.isArray(imported.contents) ? imported.contents : [];
        const incomingSettings = migratedImport.settings || imported.settings || imported.state?.settings;
        const incomingReader = migratedImport.reader || imported.reader || imported.state?.reader;

        if (!incomingBooks.length && !incomingNotes.length && !incomingContents.length) {
          showToast({ title: "No data found", message: "Import file does not contain library data.", type: "error" });
          return;
        }

        const replace = await openConfirm({
          title: "Import data",
          message: "Replace current library with imported data? Choose Cancel to merge instead.",
          confirmText: "Replace data",
          cancelText: "Merge instead"
        });

        if (replace) {
          state = defaultState();
          await resetIndexedDb();
        }

        if (incomingSettings) {
          state.settings = { ...state.settings, ...incomingSettings };
        }
        if (incomingReader) {
          state.reader = { ...state.reader, ...incomingReader };
        }
        if (migratedImport.lastOpenedBookId) {
          state.lastOpenedBookId = migratedImport.lastOpenedBookId;
          state.library.lastOpenedBookId = migratedImport.lastOpenedBookId;
        }

        if (incomingBooks.length) {
          const normalized = incomingBooks.map(b => normalizeBook(b));
          if (replace) {
            state.library.books = normalized;
          } else {
            const existing = new Map(state.library.books.map(b => [b.id, b]));
            normalized.forEach(b => existing.set(b.id, b));
            state.library.books = Array.from(existing.values());
          }
        }

        if (incomingNotes.length) {
          const normalizedNotes = incomingNotes.map(n => normalizeNote(n));
          if (replace) {
            state.notes = normalizedNotes;
          } else {
            const existing = new Map(state.notes.map(n => [n.id, n]));
            normalizedNotes.forEach(n => existing.set(n.id, n));
            state.notes = Array.from(existing.values());
          }
        }

        for (const book of state.library.books) {
          await persistBookMetadataToIdb(book.id);
        }

        if (incomingContents.length) {
          for (const content of incomingContents) {
            const entry = {
              bookId: content.bookId,
              rawText: content.rawText || "",
              tokens: Array.isArray(content.tokens) ? content.tokens : [],
              tokenCount: typeof content.tokenCount === "number" ? content.tokenCount : (content.tokens || []).length,
              updatedAt: content.updatedAt || nowISO(),
              pageRanges: Array.isArray(content.pageRanges) ? content.pageRanges : [],
              fileData: content.fileData || null,
              fileType: content.fileType || null,
              pdfTotalPages: typeof content.pdfTotalPages === "number" ? content.pdfTotalPages : null
            };
            await idbPut(DB_STORES.contents, entry);
            contentCache.set(content.bookId, entry);
          }
        }

        for (const note of state.notes) {
          await idbPut(DB_STORES.notes, note);
        }

        state.storage.migratedToIdb = true;
        state.storage.migratedAt = nowISO();
        saveState();

        stopReader(true);
        selectedBookId = null;
        selectedNoteId = null;
        applyThemeFromSettings();
        applyReaderStyleSettings();
        hydrateSettingsUI();
        renderAll();
        showToast({ title: "Import completed", message: replace ? "Library replaced." : "Library merged.", type: "success" });
      } finally {
        setButtonLoading(triggerBtn, false);
      }
    });
    input.click();
  }

  /* ---------------------------
     QA helpers
  --------------------------- */
  function runSmokeChecks() {
    const required = [
      "#main",
      "#view-library",
      "#view-reader",
      "#view-notes",
      "#view-settings",
      "#help-btn",
      "#modal-help",
      "#btn-play",
      "#book-list",
      "#note-list"
    ];
    const missing = required.filter(sel => !safeQuery(sel));
    if (missing.length) {
      console.warn("SwiftReader smoke check: missing elements", missing);
    } else {
      console.info("SwiftReader smoke check: ok");
    }
  }

  function runSmokeTestSuite() {
    const results = [];
    const record = (name, pass, detail) => {
      results.push({ name, pass, detail });
    };

    try {
      const pendingBefore = pendingMigrationWrite;
      loadState();
      pendingMigrationWrite = pendingBefore;
      record("state-load", true);
    } catch (err) {
      record("state-load", false, err instanceof Error ? err.message : String(err));
    }

    try {
      const legacy = {
        books: [{ title: "Legacy Book", text: "Hello world", sourceType: "txt" }],
        notes: [{ text: "Legacy note", bookId: "legacy" }]
      };
      const pendingBefore = pendingMigrationWrite;
      const migrated = migrateState(legacy);
      pendingMigrationWrite = pendingBefore;
      const ok = migrated.version === CURRENT_SCHEMA_VERSION && Array.isArray(migrated.library.books);
      record("migration", ok, ok ? null : "Migration did not reach current schema");
    } catch (err) {
      record("migration", false, err instanceof Error ? err.message : String(err));
    }

    try {
      const pages = [
        {
          pageIndex: 1,
          pageHeight: 800,
          lines: [
            { pageIndex: 1, pageHeight: 800, y: 780, text: "Running Title" },
            { pageIndex: 1, pageHeight: 800, y: 20, text: "1" },
            { pageIndex: 1, pageHeight: 800, y: 400, text: "Body text line" }
          ]
        },
        {
          pageIndex: 2,
          pageHeight: 800,
          lines: [
            { pageIndex: 2, pageHeight: 800, y: 780, text: "Running Title" },
            { pageIndex: 2, pageHeight: 800, y: 20, text: "2" },
            { pageIndex: 2, pageHeight: 800, y: 400, text: "More body text" }
          ]
        }
      ];
      const stripped = stripPdfHeadersFooters(pages, { enabled: true, customPhrases: [] });
      const ok = stripped.pageTexts.every(text => !/Running Title/.test(text));
      record("pdf-strip", ok, ok ? null : "Headers not stripped");
    } catch (err) {
      record("pdf-strip", false, err instanceof Error ? err.message : String(err));
    }

    try {
      const payload = {
        app: "SwiftReader",
        version: CURRENT_SCHEMA_VERSION,
        settings: state.settings,
        books: [normalizeBook({ title: "Round Trip", text: "Hello" })],
        notes: [normalizeNote({ text: "Note", bookId: "x" })]
      };
      const serialized = safeStringifyJSON(payload, "smoke export");
      const parsed = safeParseJSON(serialized, null, "smoke import");
      const ok = !!parsed && Array.isArray(parsed.books);
      record("import-export", ok, ok ? null : "Round trip failed");
    } catch (err) {
      record("import-export", false, err instanceof Error ? err.message : String(err));
    }

    const summary = results.reduce((acc, res) => {
      acc[res.pass ? "passed" : "failed"].push(res);
      return acc;
    }, { passed: [], failed: [] });
    console.info("SwiftReader smoke tests", summary);
    return { results, summary };
  }

  function logBootStatus() {
    console.groupCollapsed("SwiftReader Boot");
    console.info(`Version: ${APP_VERSION}`);
    console.info(`Storage: ${state.library.books.length} books, ${state.notes.length} notes`);
    const ids = [
      "#nav-library",
      "#nav-reader",
      "#nav-notes",
      "#nav-settings",
      "#demo-load-btn",
      "#paste-add-btn",
      "#import-confirm-btn",
      "#btn-play",
      "#save-note-btn",
      "#export-btn",
      "#import-data-btn"
    ];
    const found = ids.filter(sel => !!document.querySelector(sel));
    console.info(`DOM ready: ${found.length}/${ids.length} key elements`);
    if (bootBindings) {
      console.info(`Handlers bound: ${bootBindings.bound}/${bootBindings.attempted}`);
    }
    console.groupEnd();
  }

  function initGlobalErrorHandlers() {
    window.addEventListener("error", (event) => {
      const message = event?.message || "Unexpected error";
      notifyGlobalError(message);
    });
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event?.reason;
      const message = reason instanceof Error ? reason.message : String(reason || "Unhandled promise rejection");
      notifyGlobalError(message);
    });
  }

  function notifyGlobalError(message) {
    showFatalBanner(message);
    showToast({
      title: "SwiftReader error",
      message,
      type: "error",
      duration: 6000
    });
  }

  function showFatalBanner(message) {
    if (!fatalBanner) {
      fatalBanner = document.createElement("div");
      fatalBanner.className = "fatal-banner";
      const text = document.createElement("div");
      text.className = "fatal-banner-text";
      fatalBanner.appendChild(text);
      document.body.prepend(fatalBanner);
    }
    const textEl = fatalBanner.querySelector(".fatal-banner-text");
    if (textEl) {
      textEl.textContent = message || "App failed to start. Open console for details.";
    }
    fatalBanner.hidden = false;
  }

  function initDebugHelpers() {
    const isDev = location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "";
    if (!isDev) return;
    window.SR_DEBUG = {
      dumpState: () => JSON.parse(JSON.stringify(state)),
      reset: () => {
        state = defaultState();
        saveState();
        void resetIndexedDb();
        stopReader(true);
        selectedBookId = null;
        selectedNoteId = null;
        applyThemeFromSettings();
        applyReaderStyleSettings();
        hydrateSettingsUI();
        renderAll();
        setView("library");
        return "State reset.";
      },
      openBook: async (id) => {
        await openBookInReader(id);
        setView("reader");
        return `Opened ${id}`;
      }
    };
  }

  window.swiftreaderDebug = window.swiftreaderDebug || {};
  window.swiftreaderDebug.runSmokeTests = () => runSmokeTestSuite();
  window.swiftreaderDebug.dumpStateSummary = () => summarizeStateShape(state);
  window.swiftreaderDebug.testSerializeState = () => {
    const serialized = safeStringifyJSON(serializeStateForStorage(), "debug serialize");
    return {
      ok: !!serialized,
      length: serialized ? serialized.length : 0
    };
  };
  window.swiftreaderDebug.simulateMigration = (sample) => migrateState(sample);
  window.swiftreaderDebug.enableDiagnostics = ({ storage = false, pdfUpload = false } = {}) => {
    diagnostics.storage = !!storage;
    diagnostics.pdfUpload = !!pdfUpload;
    return { ...diagnostics };
  };

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
  bind(addBookBtn, "click", () => {
    // Focus on import area
    setView("library");
    importTitle?.focus();
  }, "#add-book-btn");

})();
