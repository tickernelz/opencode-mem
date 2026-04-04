# Web UI agent guide

## Scope

- `src/web/` is a browser-only static UI served by `src/services/web-server.ts`.
- This subtree is plain HTML/CSS/JavaScript and is copied directly to `dist/web/` during build.

## Hard rules

- Edit `src/web/*`, never `dist/web/*`.
- Do not convert this subtree to TypeScript, ESM modules, or a bundler-driven app unless the build system is intentionally redesigned.
- New user-visible strings must go through `i18n.js` in both `en` and `zh` tables.

## Where to look

- `index.html` — static shell and CDN script includes.
- `app.js` — monolithic SPA logic, state object, fetch helpers, rendering, events.
- `i18n.js` — translation tables plus `t()`/`applyLanguage()`.
- `styles.css` — full visual system for the explorer.

## Conventions

- External browser dependencies are loaded from CDN in `index.html` (`lucide`, `marked`, `DOMPurify`, `jsonrepair`). If one changes, update the HTML include, not `package.json`.
- Markdown rendering should follow the existing `marked.parse()` + `DOMPurify.sanitize()` path.
- The UI talks to backend endpoints through `fetchAPI()` and the REST paths implemented in `src/services/web-server.ts` / `api-handlers.ts`.
- The global `state` object in `app.js` is the coordination hub; new UI flows usually extend that state plus render/update helpers.

## Gotchas

- There is no type safety at the API boundary. If you add or rename an endpoint, update both the server route and the UI call sites.
- `i18n.js` updates text nodes and placeholders via `data-i18n` / `data-i18n-placeholder`; preserve that attribute-based pattern.
- This UI is intentionally self-contained. Avoid importing assumptions from the TypeScript service layer directly.
