# Decisions

The choices that shaped it, what each cost, and what I would revisit.

## 1. Patch `fetch` and `XMLHttpRequest` in the page, not the debugger API

Chrome offers two ways to see response bodies. The `chrome.debugger` API attaches the
DevTools protocol to a tab: it sees everything, and Chrome shows a "this browser is being
debugged" banner on every tab while it is attached. Or a script in the page's own world can
replace `fetch` and `XMLHttpRequest`.

I chose the second. It needs no banner and no debugger permission, it can answer a request
with zero latency without a round trip through the browser process, and the whole thing is
ordinary JavaScript that runs under test in Node.

**Cost.** It sees only what page JavaScript sends through those two APIs. Not WebSockets,
not `EventSource`, not `sendBeacon`, not requests made by a service worker or a web worker,
not images or scripts. And a page could, in principle, keep a reference to the original
`fetch` from before it was patched; running at `document_start` in the main world is what
prevents that in practice.

## 2. Hold a page's first requests until the mode is known

See "The first few milliseconds" in [architecture](architecture.md). The alternative was to
let early requests through, which makes replay useless for the requests an app makes on
load: the ones every app makes.

**Cost.** Every page load on a site that is turned on waits a few milliseconds for the
configuration, measured in [results](results.md). Sites that are not turned on have no
scripts injected and pay nothing.

## 3. Read the configuration from storage, not from the background worker

The bridge first asked the background worker for the site's configuration. That put the
worker's start-up time in every page load whenever Chrome had stopped it. Now the worker
writes each site's configuration into `chrome.storage.local` whenever it changes, and the
bridge reads it there and listens for changes.

**Cost.** In replay mode the configuration includes the recording, so the recording is
stored twice: once in IndexedDB as rows, once in storage as the page's copy.

**Would revisit.** For recordings of many megabytes, send an index first and bodies on demand.

## 4. Answers in recorded order, not first-match

Simple mocking tools give the same request the same answer every time. For a list that is
fetched, changed and fetched again, that shows the old list after the change. Blackbox gives
the nth request of a kind the nth recorded answer and then repeats the last.

Measured on eight scripted sessions: see [results](results.md).

**Cost.** A replay follows the recording, not the app's logic. Do the same things in a
different order and each kind of request still gets its own answers in order, which may not
be what a real backend would have said. It is a recording, not a simulation.

## 5. Keep the replay position across reloads

Found by measurement: the one session of eight that replayed wrongly was the one that
reloaded the page half-way. The reload reset every cursor and the app saw the list from the
start of the recording.

The position now lives in the page's `sessionStorage`, tagged with a session id, and a
reloaded page resumes from it. This also matches what a real backend does: reloading a page
does not undo what you did before.

**Cost.** One key in the site's own `sessionStorage` while replaying, visible to the site.
The alternative, keeping it in the background worker, would put a message round trip in
front of every replayed answer.

## 6. No access to a site until it is turned on

The manifest requests no host permissions except `localhost`. Each other site is an optional
permission, asked for when the user presses "Turn on for this site", and the scripts are
registered for that origin alone.

**Cost.** One more click, and a browser permission prompt, per site. An extension that reads
every response body on a page should have to ask.

## 7. Store recordings raw, redact on export

Redacting at record time would be safer and would break replay: an app that receives
`"[redacted]"` where its login token should be does not work. So recordings are kept as
captured, inside the browser, and redaction is applied when a recording is exported to a
file, by default.

**Cost.** Secrets sit in the extension's IndexedDB for as long as the recording does. They
were already in the page's memory and usually its storage; the recording does not move them
anywhere new until it is exported.

## 8. Failing closed when a request has no recorded answer

In replay mode an unrecorded request fails like a network error. The alternative, sending it
to the network, means a "replay" can quietly write to a real backend.

**Cost.** One unrecorded request can break a page. The panel lists them by name, and the
setting can be changed.

## 9. A structural comparison for drift

Comparing a live answer with a recorded one value by value would report a difference for
every id and timestamp. Compare mode looks only at shape: which fields exist and what types
they hold.

**Cost.** It cannot see a field whose meaning changed while its type stayed the same, and it
judges an array by its first element.

## 10. Not on the Chrome Web Store

The store charges a one-time developer registration fee, and this project was to cost
nothing. The extension is distributed as a zip from the repository's releases and loaded in
developer mode, which every Chromium browser supports.

**Cost.** No one-click install and no automatic updates.

## 11. A demo that runs the real code without the extension

A portfolio visitor will not install an extension to see what it does. Because the
interceptor has no dependency on extension APIs, the demo page loads it into the sample app
with a `<script>` tag and wires it to the same panel component. What runs there is the same
interception and matching code, not a mock-up of it.

**Cost.** A second `Backend` implementation and a second host to keep working, each with its
own browser test.
