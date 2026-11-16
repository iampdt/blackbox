import { StrictMode, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PanelView } from "../src/ui/PanelView";
import "../src/ui/styles.css";
import { demoBackend } from "./demo-backend";

const REPO = "https://github.com/iampdt/blackbox";

const STEPS: [string, string][] = [
  ["Record", "In the panel, press Record. The app reloads, so the recording starts from its very first request. Add a task, tick one off, and press \"Summarise my day\". Each API call appears in the panel as it happens."],
  ["Break the backend", "Press Off, then tick \"Simulate a backend outage\" in the app. Every request now fails with a 503 and the app shows an error."],
  ["Replay", "Press Replay. The app reloads and works again, answered entirely from the recording. Repeat what you did: the list changes exactly as it did before, and the summary types itself out again."],
  ["Compare", "Press Off, untick the outage, tick \"Serve version 2 of the API\", and press Compare. The Changes tab lists every field that was renamed, removed or changed type."],
];

function App() {
  const frame = useRef<HTMLIFrameElement>(null);
  const backend = useMemo(() => demoBackend(() => frame.current), []);
  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 sm:px-6">
      <header className="pt-8 pb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">
            Blackbox <span className="font-normal text-muted">· an API flight recorder for the browser</span>
          </h1>
          <nav className="flex gap-4 text-sm">
            <a className="text-accent underline underline-offset-4" href="#install">
              Install
            </a>
            <a className="text-accent underline underline-offset-4" href={REPO}>
              Source and docs
            </a>
          </nav>
        </div>
        <p className="mt-2 max-w-3xl text-sm text-pretty text-muted">
          A browser extension that records every API call a web app makes, and replays them so the app keeps working when its backend is down, slow or not built yet. It also checks whether an
          API still answers in the shape it used to. The app and panel below are live: the same code the extension runs, loaded by this page so you can try it without installing anything.
        </p>
      </header>

      <ol className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map(([title, body], index) => (
          <li key={title} className="card p-3">
            <p className="font-mono text-xs text-accent">{index + 1}</p>
            <h2 className="mt-1 text-sm font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-pretty text-muted">{body}</p>
          </li>
        ))}
      </ol>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section aria-labelledby="app-title" className="card flex h-[40rem] flex-col overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
            <h2 id="app-title" className="kicker">
              A web app with a real API
            </h2>
            <a className="text-xs text-accent underline underline-offset-4" href="/app/" target="_blank" rel="noopener">
              Open on its own
            </a>
          </div>
          <iframe ref={frame} src="/app/?embedded=1" title="Sample task app" className="min-h-0 w-full flex-1 bg-surface" />
        </section>
        <section aria-labelledby="panel-title" className="card flex h-[40rem] flex-col overflow-hidden">
          <h2 id="panel-title" className="kicker border-b border-line px-3 py-2">
            The Blackbox panel, as it appears in dev tools
          </h2>
          <div className="min-h-0 flex-1">
            <PanelView backend={backend} compact />
          </div>
        </section>
      </div>

      <section id="install" className="mt-12 max-w-3xl scroll-mt-6 space-y-3">
        <h2 className="text-lg font-semibold tracking-tight">Install the extension</h2>
        <p className="text-sm text-pretty text-muted">
          Blackbox is free and open source. It is not on the Chrome Web Store, which charges a registration fee; it installs from a download in about a minute, on Chrome, Edge, Brave or any
          Chromium browser.
        </p>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>
            Download <code className="font-mono text-xs">blackbox-extension.zip</code> from the{" "}
            <a className="text-accent underline underline-offset-4" href={`${REPO}/releases/latest`}>
              latest release
            </a>{" "}
            and unzip it.
          </li>
          <li>
            Open <code className="font-mono text-xs">chrome://extensions</code>, switch on "Developer mode", press "Load unpacked" and choose the unzipped folder.
          </li>
          <li>Open any site, click the Blackbox icon and press "Turn on for this site". It has no access to a site until you do.</li>
          <li>Open dev tools and choose the Blackbox tab.</li>
        </ol>
        <p className="text-sm text-pretty text-muted">
          Recordings stay in your browser. Nothing is sent anywhere, and exported files have passwords, tokens and keys removed by default.
        </p>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
