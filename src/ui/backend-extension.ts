// The panel's backend when it runs inside the extension: everything goes to the background worker.

import type { Mode, Recording, ReplayOptions } from "../core/types";
import type { Backend, LiveEvent, RecordingMeta, SiteState, WorkerRequest } from "../shared/protocol";

async function ask<T>(message: WorkerRequest): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(message)) as { ok: boolean; value?: T; error?: string } | undefined;
  if (!reply?.ok) throw new Error(reply?.error ?? "The extension did not answer.");
  return reply.value as T;
}

export function extensionBackend(origin: string, reload: () => void): Backend {
  return {
    origin,
    state: () => ask<SiteState>({ type: "site.get", origin }),
    async enable() {
      // Sites other than localhost need the user's say-so, asked for here, at the click.
      const origins = [`${origin}/*`];
      if (!(await chrome.permissions.contains({ origins })) && !(await chrome.permissions.request({ origins }))) {
        throw new Error("Blackbox needs permission for this site to record it.");
      }
      return ask<SiteState>({ type: "site.enable", origin });
    },
    disable: () => ask<SiteState>({ type: "site.disable", origin }),
    setMode: (mode: Mode, recordingId?: string | null, name?: string) => ask<SiteState>({ type: "site.mode", origin, mode, recordingId, name }),
    setOptions: (options: ReplayOptions) => ask<SiteState>({ type: "site.options", origin, options }),
    recordings: () => ask<RecordingMeta[]>({ type: "rec.list", origin }),
    recording: (id) => ask<Recording | null>({ type: "rec.get", id }),
    rename: (id, name) => ask<void>({ type: "rec.rename", id, name }),
    remove: (id) => ask<void>({ type: "rec.delete", id }),
    importRecording: (recording) => ask<RecordingMeta>({ type: "rec.import", recording }),
    subscribe(listener: (event: LiveEvent) => void) {
      let port: chrome.runtime.Port | null = null;
      let closed = false;
      // The background worker is stopped when idle, which closes the port; open it again.
      const connect = (again: boolean) => {
        if (closed) return;
        port = chrome.runtime.connect({ name: `panel:${origin}` });
        port.onMessage.addListener(listener);
        port.onDisconnect.addListener(() => setTimeout(() => connect(true), 100));
        // Whatever happened while the port was down was sent to nobody.
        if (again) listener({ type: "resync" });
      };
      connect(false);
      return () => {
        closed = true;
        port?.disconnect();
      };
    },
    reload,
  };
}
