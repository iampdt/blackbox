// The demo page's way of running Blackbox without the extension. The sample app, when shown
// inside the demo page, loads this before its own script. It installs the very same
// interceptor the extension injects, and takes its orders from the demo page around it
// instead of from an extension.

import { install } from "../src/core/intercept";
import { OFF, type Config, type DriftEvent, type Exchange, type ReplayEvent } from "../src/core/types";

export interface DemoHost {
  config(): Config;
  onExchange(exchange: Omit<Exchange, "seq">): void;
  onReplay(event: ReplayEvent): void;
  onDrift(event: DriftEvent): void;
}

declare global {
  interface Window {
    __blackboxDemo?: DemoHost;
    __blackboxEmbed?: { configure(config: Config): void };
  }
}

const host = (): DemoHost | undefined => {
  try {
    return window.parent !== window ? window.parent.__blackboxDemo : undefined;
  } catch {
    return undefined; // Framed by another site: nothing to take orders from.
  }
};

const interceptor = install(window as unknown as Parameters<typeof install>[0], {
  onExchange: (exchange) => host()?.onExchange(exchange),
  onReplay: (event) => host()?.onReplay(event),
  onDrift: (event) => host()?.onDrift(event),
});
window.__blackboxEmbed = interceptor;
interceptor.configure(host()?.config() ?? OFF);
