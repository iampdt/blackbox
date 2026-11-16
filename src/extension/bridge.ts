// Runs beside the page in the extension's isolated world. The page-side script cannot reach
// the extension and the extension cannot reach the page's JavaScript; this passes messages
// between them.
//
// The page's instructions are read straight from extension storage rather than asked of the
// background worker: Chrome stops that worker when it is idle, and a page that is starting
// up, with its first requests held, should not have to wait for it to start again.

import { type Config, OFF } from "../core/types";
import { configKey, type PageMessage, type WorkerRequest } from "../shared/protocol";

const key = configKey(window.location.origin);
let latest: Config | null = null;

function toPage(config: Config): void {
  latest = config;
  window.postMessage({ source: "blackbox-bridge", type: "config", config } satisfies PageMessage, window.location.origin);
}

function toWorker(message: WorkerRequest): void {
  // If the extension was reloaded or removed while this page was open, there is nobody to tell.
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

chrome.storage.local.get(key).then(
  (stored) => toPage((stored[key] as Config | undefined) ?? OFF),
  () => toPage(OFF),
);

chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[key];
  if (area === "local" && change) toPage((change.newValue as Config | undefined) ?? OFF);
});

window.addEventListener("message", (event: MessageEvent<PageMessage>) => {
  if (event.source !== window || event.data?.source !== "blackbox-page") return;
  const message = event.data;
  if (message.type === "hello") {
    if (latest) toPage(latest);
  } else if (message.type === "exchange") toWorker({ type: "page.exchange", exchange: message.exchange });
  else if (message.type === "replay") toWorker({ type: "page.replay", event: message.event });
  else if (message.type === "drift") toWorker({ type: "page.drift", event: message.event });
});
