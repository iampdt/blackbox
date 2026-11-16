// The toolbar popup: turn Blackbox on for the current site and switch modes.

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Mode } from "../core/types";
import type { Backend, RecordingMeta, SiteState } from "../shared/protocol";
import { extensionBackend } from "./backend-extension";
import "./styles.css";

const MODES: [Mode, string][] = [
  ["off", "Off"],
  ["record", "Record"],
  ["replay", "Replay"],
  ["compare", "Compare"],
];

function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab | null | undefined>(undefined);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [state, setState] = useState<SiteState | null>(null);
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
      setTab(active ?? null);
      let origin: string | null = null;
      try {
        origin = active?.url && /^https?:/.test(active.url) ? new URL(active.url).origin : null;
      } catch {
        origin = null;
      }
      if (!origin || active?.id === undefined) return;
      const tabId = active.id;
      const made = extensionBackend(origin, () => void chrome.tabs.reload(tabId));
      setBackend(made);
      void made.state().then(setState);
      void made.recordings().then(setRecordings);
    });
  }, []);

  const run = (work: () => Promise<SiteState>) => {
    setError(null);
    work().then(
      (next) => (setState(next), void backend?.recordings().then(setRecordings)),
      (failure: unknown) => setError(failure instanceof Error ? failure.message : "That did not work."),
    );
  };

  if (tab === undefined) return null;
  if (!backend || !state) {
    return <p className="p-4 text-sm text-muted">Blackbox works on web pages. Open one (http or https) and click this again.</p>;
  }
  const active = recordings.find((meta) => meta.id === state.recordingId);

  return (
    <div className="space-y-3 p-4 text-sm">
      <div>
        <h1 className="font-semibold tracking-tight">Blackbox</h1>
        <p className="truncate font-mono text-xs text-muted">{backend.origin}</p>
      </div>
      {!state.enabled ? (
        <>
          <p className="text-xs text-muted">Blackbox has no access to this site until you turn it on. The page reloads so recording starts from its first request.</p>
          <button type="button" className="btn-primary w-full py-2" onClick={() => run(async () => { const next = await backend.enable(); backend.reload?.(); return next; })}>
            Turn on for this site
          </button>
        </>
      ) : (
        <>
          <div role="group" aria-label="Mode" className="grid grid-cols-4 gap-1 rounded-md border border-line p-0.5">
            {MODES.map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={state.mode === mode}
                disabled={(mode === "replay" || mode === "compare") && !state.recordingId}
                onClick={() => run(() => backend.setMode(mode, mode === "record" ? null : state.recordingId))}
                className="rounded px-1 py-1.5 text-xs font-medium text-muted disabled:opacity-40 aria-pressed:bg-ink aria-pressed:text-canvas"
              >
                {label}
              </button>
            ))}
          </div>
          <label className="block text-xs text-muted">
            <span className="mb-1 block">Recording</span>
            <select className="input" value={state.recordingId ?? ""} disabled={state.mode === "record"} onChange={(event) => run(() => backend.setMode(state.mode === "record" ? "off" : state.mode, event.target.value || null))}>
              <option value="">None</option>
              {recordings.map((meta) => (
                <option key={meta.id} value={meta.id}>
                  {meta.name} ({meta.count})
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-muted" aria-live="polite">
            {state.mode === "record" && `Recording into "${active?.name ?? "…"}".`}
            {state.mode === "replay" && `Answering from "${active?.name ?? "…"}". The network is not used.`}
            {state.mode === "compare" && `Checking live answers against "${active?.name ?? "…"}".`}
            {state.mode === "off" && "Idle."}
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-secondary flex-1" onClick={() => backend.reload?.()}>
              Reload page
            </button>
            <button type="button" className="btn-secondary flex-1" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`panel.html?origin=${encodeURIComponent(backend.origin)}`) })}>
              Open the panel
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-critical/40 px-2 py-1.5 text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
