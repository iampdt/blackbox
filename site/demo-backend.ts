// The panel's backend on the demo page: recordings live in this tab's memory (and its
// session storage), and the "site" being recorded is the sample app in the frame beside it.

import { type Config, DEFAULT_OPTIONS, MAX_BODY_BYTES, type Mode, type Recording, type ReplayOptions } from "../src/core/types";
import { type Backend, type LiveEvent, metaOf, type RecordingMeta, type SiteState } from "../src/shared/protocol";
import type { DemoHost } from "./embed";

const STORE = "blackbox-demo-recordings";

export function demoBackend(frame: () => HTMLIFrameElement | null): Backend {
  const origin = window.location.origin;
  const listeners = new Set<(event: LiveEvent) => void>();
  const emit = (event: LiveEvent) => listeners.forEach((listener) => listener(event));
  let recordings: Recording[] = [];
  try {
    recordings = JSON.parse(sessionStorage.getItem(STORE) ?? "[]") as Recording[];
  } catch {
    recordings = [];
  }
  let state: SiteState = { origin, enabled: true, mode: "off", recordingId: null, options: DEFAULT_OPTIONS, session: "" };

  const persist = () => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(recordings));
    } catch {
      // Over the browser's quota: the recordings stay in memory for this visit.
    }
  };
  const find = (id: string | null) => recordings.find((recording) => recording.id === id) ?? null;
  const config = (): Config => {
    const needs = state.mode === "replay" || state.mode === "compare";
    const recording = needs ? find(state.recordingId) : null;
    return { mode: needs && !recording ? "off" : state.mode, recording: recording ?? undefined, options: state.options, maxBodyBytes: MAX_BODY_BYTES, session: state.session };
  };
  const apply = (next: SiteState): SiteState => {
    state = next;
    frame()?.contentWindow?.__blackboxEmbed?.configure(config());
    emit({ type: "state", state });
    return state;
  };

  const host: DemoHost = {
    config,
    onExchange(exchange) {
      const recording = state.mode === "record" ? find(state.recordingId) : null;
      if (!recording) return;
      const stored = { ...exchange, seq: recording.exchanges.length };
      recording.exchanges.push(stored);
      persist();
      emit({ type: "exchange", recordingId: recording.id, exchange: stored });
    },
    onReplay: (event) => emit({ type: "replay", event }),
    onDrift: (event) => emit({ type: "drift", event }),
  };
  window.__blackboxDemo = host;

  return {
    origin,
    state: async () => state,
    enable: async () => state,
    disable: async () => apply({ ...state, mode: "off" }),
    async setMode(mode: Mode, recordingId?: string | null, name?: string) {
      let target = recordingId === undefined ? state.recordingId : recordingId;
      if (mode === "record" && !recordingId) {
        const recording: Recording = { version: 1, id: crypto.randomUUID(), name: name ?? `Recording ${new Date().toLocaleTimeString()}`, origin, createdAt: Date.now(), exchanges: [] };
        recordings.unshift(recording);
        persist();
        target = recording.id;
        emit({ type: "recordings" });
      }
      const session = mode === "replay" || mode === "compare" ? crypto.randomUUID() : state.session;
      const next = apply({ ...state, mode, recordingId: target, session });
      // On this page a recording and a replay both begin with the app loading, so that what is
      // recorded includes the app's first requests and what is replayed starts from them.
      if ((mode === "record" && !recordingId) || mode === "replay") frame()?.contentWindow?.location.reload();
      return next;
    },
    setOptions: async (options: ReplayOptions) => apply({ ...state, options }),
    recordings: async (): Promise<RecordingMeta[]> => recordings.map(metaOf),
    recording: async (id) => {
      const found = find(id);
      return found ? structuredClone(found) : null;
    },
    async rename(id, name) {
      const found = find(id);
      if (found) found.name = name;
      persist();
    },
    async remove(id) {
      recordings = recordings.filter((recording) => recording.id !== id);
      persist();
      if (state.recordingId === id) apply({ ...state, mode: "off", recordingId: null });
      emit({ type: "recordings" });
    },
    async importRecording(recording) {
      const stored = { ...recording, id: crypto.randomUUID(), origin };
      recordings.unshift(stored);
      persist();
      emit({ type: "recordings" });
      return metaOf(stored);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: () => frame()?.contentWindow?.location.reload(),
  };
}
