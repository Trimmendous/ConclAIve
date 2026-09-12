# Themes

Themes are drop-in. To add one:

1. Copy `dark.css`, rename it, and change the `[data-theme="…"]` selector to your id.
2. Add an entry to `index.json`: `{ "id": "…", "label": "…", "file": "…", "scheme": "dark"|"light" }`.

That is the whole contract — no code changes. `app.js` reads `index.json`, injects a `<link>` for
each theme, and builds the picker from it.

Every theme must define the full token set below, because `style.css` only ever refers to tokens
and never to literal colours. A theme that omits a token inherits whatever the previously applied
theme set, which looks like a bug.

`--accent` is the *application* accent (buttons, focus rings). Per-persona colours come from each
persona's `accent` field and are set inline as `--persona-accent`, so they are independent of the
theme and must stay legible on both light and dark surfaces.

## Required tokens

Layout:   --radius --font-ui --font-code
Surfaces: --bg --surface --surface-alt --surface-hover --border --border-strong
Text:     --text --text-dim --text-faint
Semantic: --accent --on-accent --ok --warn --danger
Chrome:   --shadow --bubble-bg --bubble-border --scrim

## The `system` setting

`system` is not a theme file — it means "no `data-theme` attribute set". `light.css` supplies the
bare `:root` defaults and `dark.css` overrides them inside
`@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }`, so the OS preference wins
when the user has not chosen explicitly. A third-party theme only needs the
`:root[data-theme="…"]` block; it never participates in `system`.
