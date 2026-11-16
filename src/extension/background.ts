// The background worker. It owns the recordings and each site's state, tells the scripts in
// a page what to do, and keeps open panels up to date.
//
// Chrome may stop this worker at any moment and start it again for the next message, so it
// keeps nothing important in memory: site state is in chrome.storage, recordings in IndexedDB.

import { type Config, DEFAULT_OPTIONS, MAX_BODY_BYTES, type Mode } from "../core/types";
import { configKey, type LiveEvent, type SiteState, type WorkerRequest } from "../shared/protocol";
import * as store from "./store";

const siteKey = (origin: string) => `site:${origin}`;
const scriptId = (origin: string) => `blackbox:${origin}`;

const OFF_CONFIG = (state: Pick<SiteState, "options">): Config => ({ mode: "off", options: state.options, maxBodyBytes: MAX_BODY_BYTES });

async function getSite(origin: string): Promise<SiteState> {
  const stored = (await chrome.storage.local.get(siteKey(origin)))[siteKey(origin)] as SiteState | undefined;
  return { origin, enabled: false, mode: "off", recordingId: null, options: DEFAULT_OPTIONS, session: "", ...stored };
}

async function putSite(state: SiteState): Promise<SiteState> {
  // The page's instructions are written next to the state, in storage the scripts in a page
  // can read for themselves. A page starting up must not have to wait for this worker, which
  // Chrome may have stopped; and pages already open hear about a change from the storage
  // event, without this worker having to find and message each tab.
  await chrome.storage.local.set({ [siteKey(state.origin)]: state, [configKey(state.origin)]: state.enabled ? await configFor(state) : OFF_CONFIG(state) });
  broadcast(state.origin, { type: "state", state });
  await badge(state);
  return state;
}

// ── Panels ──

const panels = new Map<string, Set<chrome.runtime.Port>>();

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith("panel:")) return;
  const origin = port.name.slice(6);
  const set = panels.get(origin) ?? new Set();
  panels.set(origin, set.add(port));
  port.onDisconnect.addListener(() => set.delete(port));
});

function broadcast(origin: string, event: LiveEvent): void {
  for (const port of panels.get(origin) ?? []) {
    try {
      port.postMessage(event);
    } catch {
      // The panel went away between the check and the send.
    }
  }
}

// ── Pages ──

async function configFor(state: SiteState): Promise<Config> {
  const needsRecording = state.mode === "replay" || state.mode === "compare";
  const recording = needsRecording && state.recordingId ? await store.get(state.recordingId) : null;
  // A recording made on one site is never handed to another.
  const usable = recording && recording.origin === state.origin ? recording : undefined;
  return { mode: needsRecording && !usable ? "off" : state.mode, recording: usable, options: state.options, maxBodyBytes: MAX_BODY_BYTES, session: state.session };
}

async function tabsOf(origin: string): Promise<chrome.tabs.Tab[]> {
  try {
    return await chrome.tabs.query({ url: `${origin}/*` });
  } catch {
    return [];
  }
}

const BADGE: Record<Mode, [text: string, color: string]> = { off: ["", "#6b6a66"], record: ["REC", "#d03b3b"], replay: ["PLAY", "#2a78d6"], compare: ["DIFF", "#c98500"] };

async function badge(state: SiteState): Promise<void> {
  const [text, color] = BADGE[state.enabled ? state.mode : "off"];
  for (const tab of await tabsOf(state.origin)) {
    if (tab.id === undefined) continue;
    void chrome.action.setBadgeText({ tabId: tab.id, text });
    void chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color });
  }
}

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.status !== "loading" || !tab.url) return;
  try {
    void getSite(new URL(tab.url).origin).then(badge);
  } catch {
    // Not a page with an origin (a browser page, a file).
  }
});

async function enable(origin: string): Promise<SiteState> {
  // The instructions go into storage before the scripts are registered, so the first page
  // they are injected into finds something to read.
  const state = await putSite({ ...(await getSite(origin)), enabled: true });
  const id = scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [`${id}:page`, `${id}:bridge`] });
  if (existing.length < 2) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    const common = { matches: [`${origin}/*`], runAt: "document_start" as const, persistAcrossSessions: true };
    await chrome.scripting.registerContentScripts([
      // In the page's own JavaScript world, where its fetch and XMLHttpRequest live.
      { ...common, id: `${id}:page`, js: ["page.js"], world: "MAIN" },
      // In the extension's isolated world, where it can talk to this worker.
      { ...common, id: `${id}:bridge`, js: ["bridge.js"], world: "ISOLATED" },
    ]);
  }
  return state;
}

async function disable(origin: string): Promise<SiteState> {
  const id = scriptId(origin);
  await chrome.scripting.unregisterContentScripts({ ids: [`${id}:page`, `${id}:bridge`] }).catch(() => undefined);
  // Pages already open still have the scripts until they reload; the "off" written here tells them to stand down.
  return putSite({ ...(await getSite(origin)), enabled: false, mode: "off" });
}

async function setMode(origin: string, mode: Mode, recordingId: string | null | undefined, name: string | undefined): Promise<SiteState> {
  const state = await getSite(origin);
  let target = recordingId === undefined ? state.recordingId : recordingId;
  if (mode === "record" && !recordingId) {
    target = (await store.create(origin, name ?? `Recording ${new Date().toLocaleString()}`)).id;
    broadcast(origin, { type: "recordings" });
  }
  // Choosing replay or compare, even when already in it, starts the recording from its beginning.
  const session = mode === "replay" || mode === "compare" ? crypto.randomUUID() : state.session;
  return putSite({ ...state, mode, recordingId: target, session });
}

// ── Messages ──

async function handle(message: WorkerRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "site.get":
      return getSite(message.origin);
    case "site.enable":
      return enable(message.origin);
    case "site.disable":
      return disable(message.origin);
    case "site.mode":
      return setMode(message.origin, message.mode, message.recordingId, message.name);
    case "site.options":
      return putSite({ ...(await getSite(message.origin)), options: message.options });
    case "rec.list":
      return store.list(message.origin);
    case "rec.get":
      return store.get(message.id);
    case "rec.rename":
      await store.rename(message.id, message.name);
      return null;
    case "rec.delete": {
      const recording = await store.get(message.id);
      await store.remove(message.id);
      if (recording) {
        const state = await getSite(recording.origin);
        if (state.recordingId === message.id) await putSite({ ...state, mode: "off", recordingId: null });
        broadcast(recording.origin, { type: "recordings" });
      }
      return null;
    }
    case "rec.import": {
      const meta = await store.save({ ...message.recording, id: crypto.randomUUID() });
      broadcast(meta.origin, { type: "recordings" });
      return meta;
    }
  }

  // The rest come from a page, and are about the site that page is on. The origin is taken
  // from the browser's own record of the sender, never from the message.
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : null);
  if (!origin) return null;
  const state = await getSite(origin);
  switch (message.type) {
    case "page.exchange": {
      if (!state.enabled || state.mode !== "record" || !state.recordingId) return null;
      const stored = await store.append(state.recordingId, message.exchange);
      if (stored) broadcast(origin, { type: "exchange", recordingId: state.recordingId, exchange: stored });
      return null;
    }
    case "page.replay":
      broadcast(origin, { type: "replay", event: message.event });
      return null;
    case "page.drift":
      broadcast(origin, { type: "drift", event: message.event });
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: WorkerRequest, sender, respond) => {
  handle(message, sender).then(
    (value) => respond({ ok: true, value }),
    (error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // The answer comes later.
});
