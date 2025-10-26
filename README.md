# Arc

Arc is an offline-first study app for organizing diseases, drugs, and concepts.
This repository hosts the desktop-ready implementation using vanilla JavaScript
bundled for Electron.

## Features

- Runs completely offline; launch the Arc desktop app or open `index.html`
  directly in a browser.
- Token-based global search filters items in browse views.
- Study builder and sessions for flashcards, quizzes, and review.
- Export and import data, including Anki CSV.

## Getting started

Install dependencies before running tests or packaging builds:

```bash
npm install
npm test
```

## Desktop application

Arc ships with an Electron wrapper so it behaves like a native desktop
application. During development you can start the packaged shell with:

```bash
npm start
```

This command rebuilds the JavaScript bundle and launches Electron. To produce a
clickable binary, run:

```bash
npm run package
```

The generated installers are written to the `dist/` folder.

## Browser usage

You can still use the app by opening `index.html` directly in a modern
browser—no local server is required.

The repository includes a pre-built `bundle.js` so the app runs without a module
loader. If you modify files under `js/`, regenerate the bundle:

```bash
npm run bundle
```

Before opening a pull request, run the convenience script below to rebuild the
bundle and execute the automated tests in one step:

```bash
npm run prepare:pr
```

The **Settings** tab lets you adjust the daily review target and manage
curriculum blocks with their lectures. It also offers buttons to export or
import the database as JSON and to export an Anki-compatible CSV. Data is stored
locally using IndexedDB.

> **Note:** Arc requires a browser with IndexedDB support. If storage
> initialization fails, the app will show “Failed to load app.”

Browse views include a global search box in the header to filter items by
matching text tokens.

## Manual QA

When working on the rich text editor, validate formatting commands with the
following smoke test:

1. Open `index.html` in a browser and create or edit a note so the rich text
   editor appears.
2. Enter sample text, select a portion of it, and click one of the highlight
   color swatches.
3. Click back into the highlighted text—confirm the toolbar's **B** (bold)
   button does **not** toggle unexpectedly.

## Roadmap

See the implementation blueprint in the repository for planned modules and
features.
