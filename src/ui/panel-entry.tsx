// The panel as an extension page. It is shown inside dev tools, where it follows the
// inspected tab, and can also be opened in a tab of its own with ?origin=….

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { extensionBackend } from "./backend-extension";
import { PanelView } from "./PanelView";
import "./styles.css";

const inDevtools = typeof chrome.devtools !== "undefined";

function currentOrigin(): Promise<string | null> {
  const fromQuery = new URLSearchParams(window.location.search).get("origin");
  if (fromQuery) return Promise.resolve(fromQuery);
  if (!inDevtools) return Promise.resolve(null);
  return new Promise((resolve) => chrome.devtools.inspectedWindow.eval("location.origin", (result) => resolve(typeof result === "string" && /^https?:/.test(result) ? result : null)));
}

function reloadPage(origin: string): void {
  if (inDevtools) chrome.devtools.inspectedWindow.reload({});
  else void chrome.tabs.query({ url: `${origin}/*` }).then((tabs) => tabs.forEach((tab) => tab.id !== undefined && void chrome.tabs.reload(tab.id)));
}

function App() {
  const [origin, setOrigin] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const load = () => void currentOrigin().then(setOrigin);
    load();
    if (!inDevtools) return;
    // The inspected tab can navigate to another site while dev tools stay open.
    chrome.devtools.network.onNavigated.addListener(load);
    return () => chrome.devtools.network.onNavigated.removeListener(load);
  }, []);
  if (origin === undefined) return null;
  if (origin === null) return <p className="p-6 text-sm text-muted">Blackbox works on web pages. Open one (http or https) and come back.</p>;
  return <PanelView key={origin} backend={extensionBackend(origin, () => reloadPage(origin))} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
