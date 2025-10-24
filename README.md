# Sevenn

Sevenn is an offline-first study app for organizing diseases, drugs, and concepts.
This repository hosts the SPA implementation using vanilla JavaScript, bundled for direct use from the filesystem.

## Features

- Runs completely offline; open `index.html` to get started.
- Token-based global search filters items in browse views.
- Study builder and sessions for flashcards, quizzes, and review.
- Export and import data, including Anki CSV.

## Development

To run the optional test suite or future tooling, install dependencies and run tests:

```bash
npm install
npm test
```

To use the app, simply open `index.html` directly in a modern browser—no build
step or local server is required.

The repository includes a pre-built `bundle.js` so the app runs without a module
loader. If you modify files under `js/`, regenerate the bundle:

```bash
npx esbuild js/main.js --bundle --format=iife --global-name=Sevenn --outfile=bundle.js
```

The **Settings** tab lets you adjust the daily review target and manage curriculum
blocks with their lectures. It also offers buttons to export or import the
database as JSON and to export an Anki-compatible CSV. Data is stored locally
using IndexedDB.

> **Note:** Sevenn requires a browser with IndexedDB support. If storage
> initialization fails, the app will show “Failed to load app.”

Browse views include a global search box in the header to filter items by
matching text tokens.

## Manual QA

When working on the rich text editor, validate formatting commands with the following smoke test:

1. Open `index.html` in a browser and create or edit a note so the rich text editor appears.
2. Enter sample text, select a portion of it, and click one of the highlight color swatches.
3. Click back into the highlighted text—confirm the toolbar's **B** (bold) button does **not** toggle unexpectedly.

## Roadmap

See the implementation blueprint in the repository for planned modules and features