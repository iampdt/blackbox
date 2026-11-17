# AGENTS.md

Working notes for anyone (or any coding agent) changing Blackbox. `docs/architecture.md`
explains the extension's parts; `docs/decisions.md` explains why.

## What it is

A Manifest V3 Chrome extension that records every fetch and XMLHttpRequest a page makes, replays
them with no network, and compares live answers with a recording for changes in shape. A demo
site on Cloudflare runs the same interceptor beside a sample app.

## Layout

| Path | Holds |
| --- | --- |
| `src/core/` | Framework-free interceptor, matcher, redaction, drift detection, export (HAR, MSW, JSON) |
| `src/extension/` | Background worker, page and bridge scripts, IndexedDB store |
| `src/ui/` | The panel, shared by the extension and the demo site |
| `site/` | Sample app, demo page, Cloudflare Worker |
| `e2e/` | Playwright tests with the real extension loaded |
| `scripts/` | Build, measurements, cold start, real-site runs, screenshots |

## Commands

```sh
npm run check        # types, unit tests, build
npm run e2e          # browser tests (first: npx playwright install chromium)
npm run package      # dist/blackbox-extension.zip for a GitHub release
npm run deploy       # check, then deploy the demo site
```

## Rules

- Recordings stay in the browser as captured; every export (HAR, MSW, JSON) is redacted by
  default. Keep it that way in any new format.
- Don't rebuild `dist/` while a measurement script is running: the scripts load the built
  extension.
- The filesystem on the main machine is case-insensitive: keep file names distinct beyond letter
  case (`Panel.tsx` and `panel.tsx` are the same file there).
- Every number in the README comes from `docs/results.md`; re-measure before changing one.
