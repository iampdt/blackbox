# Development

## Requirements

Node 22 or newer. For the browser tests, the Chromium that Playwright downloads
(`npx playwright install chromium`).

## Build and load

```bash
npm install
npm run build        # dist/extension and dist/site
```

Open `chrome://extensions`, switch on "Developer mode", press "Load unpacked" and choose
`dist/extension`. After a rebuild, press the reload arrow on the extension's card.

## Checks

```bash
npm run check        # typecheck, unit tests, build
npm run e2e          # browser tests: real Chromium, the built extension loaded
```

| Tests | Run in | Cover |
| --- | --- | --- |
| `test/core.test.ts` | Node | Bodies, request keys, the replayer, redaction, drift, HAR and MSW export and import |
| `test/intercept.test.ts` | Node, with stand-ins for `fetch` and `XMLHttpRequest` | Holding requests until configured; recording; replaying; comparing; streams; resuming after a reload |
| `e2e/extension.spec.ts` | Chromium with the extension | Turning on per site; record then replay with the backend switched off; reload mid-replay; drift; HAR export and import; the background worker being stopped; turning off |
| `e2e/demo.spec.ts` | Chromium, no extension | The demo page recording and replaying the framed sample app |

The browser tests open the panel as an extension page in a tab (`panel.html?origin=…`)
rather than inside dev tools, which automation cannot drive. It is the same page.

`localhost` is the only site the extension has access to without asking, which is also what
lets the tests turn it on without a permission prompt.

## The sample app and demo site

`site/` is a small task list with a real API (`site/api.ts`), used three ways:

- served by a Cloudflare Worker at the public demo, with one Durable Object per visitor;
- served by `e2e/server.ts` for the browser tests and measurements;
- shown in a frame on the demo page, where it loads the interceptor with a script tag.

```bash
npx wrangler deploy      # deploys dist/site and the Worker
```

## Measurements

Each prints what it measured; the output is kept in `docs/data`.

```bash
npx tsx scripts/measure.ts        # per-request cost, page-start cost, replay fidelity on eight sessions
npx tsx scripts/cold-start.ts     # page start with the background worker awake and stopped
npx tsx scripts/real-sites.ts     # record and replay four deployed sites with the network blocked
npx tsx scripts/screenshots.ts    # the README's screenshots
```

Do not rebuild `dist/` while one of these is running: they load the built extension.

## Layout

```
src/core/        the interceptor and everything it needs; no extension APIs
  intercept.ts     patched fetch and XMLHttpRequest: record, replay, compare
  match.ts         request keys and the replayer
  redact.ts        removing secrets from exports
  drift.ts         structural comparison of two responses
  export.ts        HAR, MSW handlers, JSON; HAR and JSON import
  body.ts, types.ts
src/extension/   the Manifest V3 extension
  background.ts    site state, script registration, message routing
  page.ts          main-world script: installs the interceptor
  bridge.ts        isolated-world script: page ↔ extension
  store.ts         recordings in IndexedDB
src/ui/          the panel (shared), the popup, and the panel's extension backend
src/shared/      message types and the Backend interface
site/            the sample app, its API, the demo page and its Worker
e2e/             browser tests, the local server, the harness
scripts/         build, measurements, screenshots
test/            unit tests
```

Two file names in `src/ui` differ on purpose by more than case (`PanelView.tsx`,
`panel-entry.tsx`): macOS and Windows treat `Panel.tsx` and `panel.tsx` as one file.
