// The panel: what Blackbox is doing on one site, and everything it has recorded there.
// It talks only to a Backend, so the same component runs in the extension and on the demo site.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fromHar, fromJson, toHar, toMsw } from "../core/export";
import { redactRecording } from "../core/redact";
import type { DriftEvent, Exchange, HeaderList, Mode, Recording, ReplayEvent, ReplayOptions } from "../core/types";
import type { Backend, RecordingMeta, SiteState } from "../shared/protocol";
import { bytes, download, kindOf, ms, pathOf, readable, slug } from "./format";

const VERSION = "0.1.0";

const MODES: { id: Mode; label: string; about: string }[] = [
  { id: "off", label: "Off", about: "Requests go to the network untouched." },
  { id: "record", label: "Record", about: "Every API call is saved into a new recording." },
  { id: "replay", label: "Replay", about: "API calls are answered from the recording. The network is not used." },
  { id: "compare", label: "Compare", about: "API calls go to the network, and each answer is checked against the recording for changes in shape." },
];

type Tab = "requests" | "recordings" | "drift" | "settings";

function Dot({ tone }: { tone: "good" | "warning" | "critical" | "neutral" }) {
  const color = { good: "bg-good", warning: "bg-warning", critical: "bg-critical", neutral: "bg-faint" }[tone];
  return <span aria-hidden className={`inline-block size-1.5 shrink-0 rounded-full ${color}`} />;
}

function statusTone(exchange: Exchange): "good" | "warning" | "critical" {
  if (!exchange.response) return "critical";
  return exchange.response.status >= 500 ? "critical" : exchange.response.status >= 400 ? "warning" : "good";
}

export function PanelView({ backend, compact = false }: { backend: Backend; compact?: boolean }) {
  const [state, setState] = useState<SiteState | null>(null);
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [replays, setReplays] = useState<ReplayEvent[]>([]);
  const [drifts, setDrifts] = useState<DriftEvent[]>([]);
  const [tab, setTab] = useState<Tab>("requests");
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shownId = useRef<string | null>(null);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }, []);

  const loadRecordings = useCallback(() => backend.recordings().then(setRecordings), [backend]);
  const show = useCallback(
    async (id: string | null) => {
      shownId.current = id;
      setSelected(null);
      const loaded = id ? await backend.recording(id) : null;
      if (shownId.current === id) setRecording(loaded);
    },
    [backend],
  );

  useEffect(() => {
    const loadAll = () => {
      void backend.state().then((loaded) => {
        setState(loaded);
        void show(loaded.recordingId);
      });
      void loadRecordings();
    };
    loadAll();
    return backend.subscribe((event) => {
      if (event.type === "resync") loadAll();
      else if (event.type === "state") {
        setState((previous) => {
          if (previous?.mode !== event.state.mode || previous?.recordingId !== event.state.recordingId) {
            setReplays([]);
            setDrifts([]);
            if (previous?.recordingId !== event.state.recordingId) void show(event.state.recordingId);
          }
          return event.state;
        });
      } else if (event.type === "recordings") void loadRecordings();
      else if (event.type === "replay") setReplays((list) => [...list.slice(-499), event.event]);
      else if (event.type === "drift") setDrifts((list) => [...list.slice(-499), event.event]);
      else if (event.type === "exchange") {
        setRecording((current) => (current && current.id === event.recordingId && !current.exchanges.some((e) => e.seq === event.exchange.seq) ? { ...current, exchanges: [...current.exchanges, event.exchange] } : current));
        setRecordings((list) => list.map((meta) => (meta.id === event.recordingId ? { ...meta, count: Math.max(meta.count, event.exchange.seq + 1) } : meta)));
      }
    });
  }, [backend, loadRecordings, show]);

  const served = useMemo(() => {
    const counts = new Map<number, number>();
    for (const event of replays) if (event.seq !== null) counts.set(event.seq, (counts.get(event.seq) ?? 0) + 1);
    return counts;
  }, [replays]);
  const misses = useMemo(() => replays.filter((event) => event.seq === null), [replays]);
  const drifted = useMemo(() => drifts.filter((event) => event.differences.length > 0), [drifts]);

  if (!state) return <p className="p-4 text-sm text-muted">Loading…</p>;

  const active = recordings.find((meta) => meta.id === state.recordingId) ?? null;
  const setMode = (mode: Mode) =>
    run(async () => {
      if ((mode === "replay" || mode === "compare") && !state.recordingId) throw new Error("Pick a recording first, or record one.");
      setState(await backend.setMode(mode, mode === "record" ? null : state.recordingId));
    });

  const status = !state.enabled
    ? "Blackbox is not running on this site."
    : state.mode === "record"
      ? `Recording into "${active?.name ?? "…"}": ${recording?.exchanges.length ?? 0} requests so far.`
      : state.mode === "replay"
        ? `Replaying "${active?.name ?? "…"}": ${replays.length - misses.length} answered from the recording, ${misses.length} with no recorded answer.`
        : state.mode === "compare"
          ? `Comparing with "${active?.name ?? "…"}": ${drifts.length} checked, ${drifted.length} changed.`
          : "Idle. Requests go to the network untouched.";

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <header className="border-b border-line bg-surface px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="font-semibold tracking-tight">Blackbox</h1>
          <code className="min-w-0 truncate font-mono text-xs text-muted">{backend.origin}</code>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {state.enabled ? (
              <>
                <div role="group" aria-label="Mode" className="flex rounded-md border border-line p-0.5">
                  {MODES.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      title={mode.about}
                      aria-pressed={state.mode === mode.id}
                      disabled={busy}
                      onClick={() => void setMode(mode.id)}
                      className="rounded px-2.5 py-1 text-xs font-medium text-muted aria-pressed:bg-ink aria-pressed:text-canvas"
                    >
                      {mode.id === "record" && state.mode === "record" && <span aria-hidden className="mr-1.5 inline-block size-1.5 rounded-full bg-critical align-middle" />}
                      {mode.label}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <span>Recording</span>
                  <select
                    className="input w-44 py-1"
                    value={state.recordingId ?? ""}
                    disabled={busy || state.mode === "record"}
                    onChange={(event) => void run(async () => setState(await backend.setMode(state.mode === "record" ? "off" : state.mode, event.target.value || null)))}
                  >
                    <option value="">None</option>
                    {recordings.map((meta) => (
                      <option key={meta.id} value={meta.id}>
                        {meta.name} ({meta.count})
                      </option>
                    ))}
                  </select>
                </label>
                {(state.mode === "replay" || state.mode === "compare") && (
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={busy}
                    title="Go back to the first recorded answers and reload the page"
                    onClick={() => void run(async () => (setState(await backend.setMode(state.mode, state.recordingId)), backend.reload?.()))}
                  >
                    Start over
                  </button>
                )}
                {backend.reload && (
                  <button type="button" className="btn-secondary" onClick={backend.reload} title="Reload the page. A replay carries on from where it was.">
                    Reload page
                  </button>
                )}
              </>
            ) : (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(async () => (setState(await backend.enable()), backend.reload?.()))}>
                Turn on for this site
              </button>
            )}
          </div>
        </div>
        <p className="mt-2 text-xs text-muted" aria-live="polite" data-testid="status">
          {status}
        </p>
        {error && (
          <p role="alert" className="mt-2 rounded-md border border-critical/40 px-2 py-1.5 text-xs">
            {error}
          </p>
        )}
      </header>

      <nav aria-label="Sections" className="flex gap-1 border-b border-line px-2">
        {(
          [
            ["requests", `Requests${recording ? ` (${recording.exchanges.length})` : ""}`],
            ["recordings", `Recordings (${recordings.length})`],
            ["drift", `Changes${drifted.length ? ` (${drifted.length})` : ""}`],
            ["settings", "Settings"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
            className="-mb-px border-b-2 border-transparent px-2.5 py-2 text-xs text-muted hover:text-ink aria-[current=page]:border-ink aria-[current=page]:font-medium aria-[current=page]:text-ink"
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "requests" && <Requests recording={recording} origin={backend.origin} mode={state.mode} served={served} misses={misses} selected={selected} onSelect={setSelected} compact={compact} />}
        {tab === "recordings" && (
          <Recordings
            backend={backend}
            recordings={recordings}
            state={state}
            busy={busy}
            run={run}
            onChanged={loadRecordings}
            onUse={(id) => void run(async () => (setState(await backend.setMode(state.mode === "record" ? "off" : state.mode, id)), setTab("requests")))}
          />
        )}
        {tab === "drift" && <Drift drifts={drifts} mode={state.mode} origin={backend.origin} />}
        {tab === "settings" && <Settings state={state} busy={busy} onSave={(options) => void run(async () => setState(await backend.setOptions(options)))} onDisable={() => void run(async () => setState(await backend.disable()))} />}
      </div>
    </div>
  );
}

// ── Requests ────────────────────────────────────────────────────────────────

function Requests({
  recording,
  origin,
  mode,
  served,
  misses,
  selected,
  onSelect,
  compact,
}: {
  recording: Recording | null;
  origin: string;
  mode: Mode;
  served: Map<number, number>;
  misses: ReplayEvent[];
  selected: number | null;
  onSelect: (seq: number | null) => void;
  compact: boolean;
}) {
  const [filter, setFilter] = useState("");
  if (!recording) {
    return <p className="p-6 text-center text-sm text-muted">No recording selected. Choose "Record" and use the page: every API call it makes will appear here.</p>;
  }
  const needle = filter.trim().toLowerCase();
  const rows = needle ? recording.exchanges.filter((e) => `${e.request.method} ${e.request.url} ${e.response?.status ?? ""}`.toLowerCase().includes(needle)) : recording.exchanges;
  const open = selected === null ? null : (recording.exchanges.find((e) => e.seq === selected) ?? null);
  const replaying = mode === "replay";

  return (
    <div className={`grid h-full min-h-0 ${open && !compact ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : ""}`}>
      <div className={`min-h-0 overflow-auto ${open && compact ? "hidden" : ""}`}>
        {misses.length > 0 && (
          <div className="border-b border-line bg-accent-soft px-3 py-2 text-xs" data-testid="misses">
            <p className="font-medium">
              {misses.length} request{misses.length > 1 ? "s" : ""} had no recorded answer
            </p>
            <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted">
              {[...new Set(misses.map((m) => `${m.method} ${pathOf(m.url, origin)}`))].slice(0, 6).map((line) => (
                <li key={line} className="truncate">
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="sticky top-0 z-10 border-b border-line bg-canvas px-2 py-1.5">
          <input className="input" type="search" placeholder="Filter by method, URL or status" aria-label="Filter requests" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </div>
        {recording.exchanges.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted">Nothing recorded yet. Use the page, or reload it to capture its first requests.</p>
        ) : (
          <table className="w-full table-fixed text-left text-xs">
            <thead className="text-[11px] text-muted">
              <tr className="border-b border-line">
                <th scope="col" className="w-9 px-2 py-1.5 font-medium">#</th>
                <th scope="col" className="w-16 px-2 py-1.5 font-medium">Method</th>
                <th scope="col" className="px-2 py-1.5 font-medium">Path</th>
                <th scope="col" className="w-16 px-2 py-1.5 font-medium">Status</th>
                <th scope="col" className="hidden w-16 px-2 py-1.5 font-medium sm:table-cell">Type</th>
                <th scope="col" className="hidden w-16 px-2 py-1.5 text-right font-medium sm:table-cell">Size</th>
                <th scope="col" className="w-16 px-2 py-1.5 text-right font-medium">Time</th>
                {replaying && <th scope="col" className="w-16 px-2 py-1.5 text-right font-medium">Replayed</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((exchange) => (
                <tr
                  key={exchange.seq}
                  onClick={() => onSelect(exchange.seq === selected ? null : exchange.seq)}
                  className={`cursor-pointer border-b border-line hover:bg-accent-soft ${exchange.seq === selected ? "bg-accent-soft" : ""}`}
                >
                  <td className="px-2 py-1.5 font-mono text-faint tabular-nums">{exchange.seq + 1}</td>
                  <td className="px-2 py-1.5 font-mono">{exchange.request.method}</td>
                  <td className="truncate px-2 py-1.5 font-mono" title={exchange.request.url}>
                    <button type="button" className="max-w-full truncate text-left" aria-expanded={exchange.seq === selected}>
                      {pathOf(exchange.request.url, origin)}
                    </button>
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                      <Dot tone={statusTone(exchange)} />
                      {exchange.response?.status ?? "failed"}
                    </span>
                  </td>
                  <td className="hidden truncate px-2 py-1.5 text-muted sm:table-cell">{kindOf(exchange)}</td>
                  <td className="hidden px-2 py-1.5 text-right font-mono text-muted tabular-nums sm:table-cell">{exchange.response ? bytes(exchange.response.body.size) : "–"}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-muted tabular-nums">{ms(exchange.totalMs)}</td>
                  {replaying && <td className="px-2 py-1.5 text-right font-mono tabular-nums">{served.get(exchange.seq) ?? "–"}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && <Detail exchange={open} onClose={() => onSelect(null)} />}
    </div>
  );
}

function Headers({ headers }: { headers: HeaderList }) {
  if (headers.length === 0) return <p className="text-xs text-faint">None visible to the page.</p>;
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
      {headers.map(([name, value], index) => (
        <div key={index} className="contents">
          <dt className="text-muted">{name}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function BodyView({ body, headers }: { body: Exchange["request"]["body"]; headers: HeaderList }) {
  const { text, note } = readable(body, headers);
  return (
    <>
      {note && <p className="text-xs text-faint">{note}</p>}
      {text && <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">{text}</pre>}
    </>
  );
}

function Detail({ exchange, onClose }: { exchange: Exchange; onClose: () => void }) {
  const { request, response } = exchange;
  return (
    <aside aria-label="Request details" className="min-h-0 overflow-auto border-l border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-mono text-xs break-all">
          <span className="font-semibold">{request.method}</span> {request.url}
        </p>
        <button type="button" className="btn-secondary shrink-0" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-2 text-xs text-muted">
        {response ? `${response.status} ${response.statusText}` : `Failed: ${exchange.error}`} · sent by {exchange.via === "xhr" ? "XMLHttpRequest" : "fetch"} · headers after {ms(exchange.waitMs)}, complete after{" "}
        {ms(exchange.totalMs)} · {new Date(exchange.startedAt).toLocaleTimeString()}
      </p>
      <section className="mt-4 space-y-2">
        <h3 className="kicker">Request headers</h3>
        <Headers headers={request.headers} />
        <h3 className="kicker pt-2">Request body</h3>
        <BodyView body={request.body} headers={request.headers} />
      </section>
      {response && (
        <section className="mt-5 space-y-2">
          <h3 className="kicker">Response headers</h3>
          <Headers headers={response.headers} />
          <h3 className="kicker pt-2">Response body</h3>
          <BodyView body={response.body} headers={response.headers} />
          {response.chunks && (
            <>
              <h3 className="kicker pt-2">Arrived as a stream, in {response.chunks.length} pieces</h3>
              <ol className="max-h-48 space-y-0.5 overflow-auto font-mono text-[11px]">
                {response.chunks.map((chunk, index) => (
                  <li key={index} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
                    <span className="text-right text-faint tabular-nums">+{ms(chunk.atMs)}</span>
                    <span className="truncate">{JSON.stringify(chunk.data).slice(1, -1)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </section>
      )}
    </aside>
  );
}

// ── Recordings ──────────────────────────────────────────────────────────────

function Recordings({
  backend,
  recordings,
  state,
  busy,
  run,
  onChanged,
  onUse,
}: {
  backend: Backend;
  recordings: RecordingMeta[];
  state: SiteState;
  busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
  onChanged: () => Promise<unknown>;
  onUse: (id: string) => void;
}) {
  const [redact, setRedact] = useState(true);
  // Renaming and deleting are done in place: browser dialogs do not open inside a dev tools panel.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const exportAs = (meta: RecordingMeta, format: "har" | "json" | "msw") =>
    run(async () => {
      const loaded = await backend.recording(meta.id);
      if (!loaded) throw new Error("That recording is gone.");
      const recording = redact ? redactRecording(loaded) : loaded;
      if (format === "har") download(`${slug(meta.name)}.har`, JSON.stringify(toHar(recording, VERSION), null, 2), "application/json");
      else if (format === "json") download(`${slug(meta.name)}.blackbox.json`, JSON.stringify(recording, null, 2), "application/json");
      else download(`${slug(meta.name)}.handlers.ts`, toMsw(recording), "text/plain");
    });

  const importFile = (chosen: File) =>
    run(async () => {
      const parsed = JSON.parse(await chosen.text()) as { log?: unknown };
      const name = chosen.name.replace(/\.(blackbox\.json|har|json)$/i, "");
      // A recording is tied to the site it is used on; an imported one is tied to this site.
      const recording = parsed.log ? fromHar(parsed, backend.origin, name, crypto.randomUUID()) : { ...fromJson(parsed, crypto.randomUUID()), origin: backend.origin };
      if (recording.exchanges.length === 0) throw new Error("That file has no API calls in it.");
      await backend.importRecording(recording);
      await onChanged();
    });

  return (
    <div className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => file.current?.click()}>
          Import a HAR or Blackbox file
        </button>
        <input
          ref={file}
          type="file"
          accept=".har,.json,application/json"
          className="sr-only"
          aria-label="Recording file to import"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (chosen) void importFile(chosen);
            event.target.value = "";
          }}
        />
        <label className="inline-flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={redact} onChange={(event) => setRedact(event.target.checked)} />
          Remove passwords, tokens and keys from exported files
        </label>
      </div>
      {recordings.length === 0 ? (
        <p className="card p-6 text-center text-sm text-muted">No recordings for this site yet.</p>
      ) : (
        <ul className="space-y-2">
          {recordings.map((meta) => (
            <li key={meta.id} className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
              <div className="min-w-0 flex-1">
                {renaming === meta.id ? (
                  <form
                    className="flex gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = draft.trim();
                      if (name) void run(async () => (await backend.rename(meta.id, name), setRenaming(null), await onChanged()));
                    }}
                  >
                    <input className="input" autoFocus aria-label="Recording name" value={draft} onChange={(event) => setDraft(event.target.value)} />
                    <button type="submit" className="btn-primary">
                      Save
                    </button>
                    <button type="button" className="btn-secondary" onClick={() => setRenaming(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <p className="truncate font-medium">
                    {meta.name}
                    {meta.id === state.recordingId && <span className="ml-2 rounded-full border border-line px-1.5 py-0.5 text-[10px] font-normal text-muted">in use</span>}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-muted">
                  {meta.count} requests · {bytes(meta.bytes)} · {new Date(meta.createdAt).toLocaleString()}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button type="button" className="btn-secondary" disabled={busy || meta.id === state.recordingId} onClick={() => onUse(meta.id)}>
                  Use
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void exportAs(meta, "har")} title="Opens in browser dev tools; Playwright replays it with page.routeFromHAR">
                  HAR
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void exportAs(meta, "msw")} title="Mock Service Worker handlers for tests">
                  MSW
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void exportAs(meta, "json")} title="Blackbox's own format; this is what Import reads">
                  JSON
                </button>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => (setRenaming(meta.id), setDraft(meta.name))}>
                  Rename
                </button>
                {confirming === meta.id ? (
                  <button type="button" className="btn bg-critical text-white" disabled={busy} onBlur={() => setConfirming(null)} onClick={() => void run(async () => (await backend.remove(meta.id), setConfirming(null), await onChanged()))}>
                    Delete for good
                  </button>
                ) : (
                  <button type="button" className="btn-secondary" disabled={busy || (meta.id === state.recordingId && state.mode === "record")} onClick={() => setConfirming(meta.id)}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Changes ─────────────────────────────────────────────────────────────────

const DIFFERENCE: Record<string, (d: DriftEvent["differences"][number]) => string> = {
  added: (d) => `${d.path}: new field (${d.live})`,
  removed: (d) => `${d.path}: field is gone (was ${d.recorded})`,
  type: (d) => `${d.path}: was ${d.recorded}, now ${d.live}`,
  status: (d) => `Status was ${d.recorded}, now ${d.live}`,
  "content-type": (d) => `Content type was ${d.recorded}, now ${d.live}`,
};

function Drift({ drifts, mode, origin }: { drifts: DriftEvent[]; mode: Mode; origin: string }) {
  if (mode !== "compare" && drifts.length === 0) {
    return <p className="p-6 text-center text-sm text-muted">Choose "Compare" and use the page. Each live answer is checked against the recording, and any change in its shape is listed here.</p>;
  }
  if (drifts.length === 0) return <p className="p-6 text-center text-sm text-muted">Nothing compared yet. Use the page.</p>;
  const changed = drifts.filter((d) => d.differences.length > 0);
  const unknown = drifts.filter((d) => d.seq === null);
  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-muted">
        {drifts.length} answers checked. {changed.length} changed shape, {unknown.length} were requests the recording does not have, {drifts.length - changed.length - unknown.length} matched.
      </p>
      {changed.length === 0 && <p className="card p-4 text-sm">No changes: every answer has the same fields and types as when it was recorded.</p>}
      <ul className="space-y-2">
        {changed.map((drift, index) => (
          <li key={index} className="card p-3">
            <p className="font-mono text-xs break-all">
              <span className="font-semibold">{drift.method}</span> {pathOf(drift.url, origin)}
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {drift.differences.map((difference, at) => (
                <li key={at} className="flex items-baseline gap-2">
                  <Dot tone={difference.kind === "added" ? "neutral" : "warning"} />
                  <span className="font-mono">{DIFFERENCE[difference.kind]?.(difference)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function Settings({ state, busy, onSave, onDisable }: { state: SiteState; busy: boolean; onSave: (options: ReplayOptions) => void; onDisable: () => void }) {
  const [options, setOptions] = useState(state.options);
  const [query, setQuery] = useState(state.options.ignoreQuery.join(", "));
  const [fields, setFields] = useState(state.options.ignoreBodyFields.join(", "));
  const list = (text: string) =>
    text
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const radio = <K extends keyof ReplayOptions>(key: K, value: ReplayOptions[K], label: string) => (
    <label className="flex items-start gap-2">
      <input type="radio" className="mt-0.5" name={key} checked={options[key] === value} onChange={() => setOptions({ ...options, [key]: value })} />
      <span>{label}</span>
    </label>
  );
  return (
    <form
      className="max-w-2xl space-y-5 p-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ ...options, ignoreQuery: list(query), ignoreBodyFields: list(fields) });
      }}
    >
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 font-medium">When the same request was recorded more than once</legend>
        {radio("sequence", "ordered", "Give its answers in the order they were recorded, then repeat the last (a list fetched before and after a change shows the change)")}
        {radio("sequence", "first", "Always give the first answer")}
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 font-medium">When a request has no recorded answer</legend>
        {radio("unmatched", "block", "Fail it like a network error, so nothing reaches the real backend")}
        {radio("unmatched", "network", "Send it to the network")}
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 font-medium">Replay speed</legend>
        {radio("speed", 0, "Answer at once")}
        {radio("speed", 1, "Answer at the recorded pace, streams included")}
      </fieldset>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={options.loose} onChange={(event) => setOptions({ ...options, loose: event.target.checked })} />
        <span>If nothing closer matches, match on method and path alone (ignores the query and the body)</span>
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">Query parameters to ignore when matching</span>
        <input className="input font-mono" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block font-medium">JSON body fields to ignore when matching</span>
        <input className="input font-mono" value={fields} onChange={(event) => setFields(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          Save settings
        </button>
        {state.enabled && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={onDisable}>
            Turn off for this site
          </button>
        )}
      </div>
    </form>
  );
}
