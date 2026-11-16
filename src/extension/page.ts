// Runs in the page's own JavaScript world, before any of the page's scripts.
// Replaces fetch and XMLHttpRequest and reports through the bridge.

import { install } from "../core/intercept";
import type { PageMessage } from "../shared/protocol";

declare global {
  interface Window {
    __blackboxInstalled?: boolean;
  }
}

if (!window.__blackboxInstalled) {
  window.__blackboxInstalled = true;
  const send = (message: PageMessage) => window.postMessage(message, window.location.origin);
  const interceptor = install(window as unknown as Parameters<typeof install>[0], {
    onExchange: (exchange) => send({ source: "blackbox-page", type: "exchange", exchange }),
    onReplay: (event) => send({ source: "blackbox-page", type: "replay", event }),
    onDrift: (event) => send({ source: "blackbox-page", type: "drift", event }),
  });
  window.addEventListener("message", (event: MessageEvent<PageMessage>) => {
    if (event.source !== window || event.data?.source !== "blackbox-bridge") return;
    if (event.data.type === "config") interceptor.configure(event.data.config);
  });
  // In case the bridge started first and has the configuration already.
  send({ source: "blackbox-page", type: "hello" });
}
