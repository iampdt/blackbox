# Results

Measured on 17 November 2026 in Chromium 159 with the built extension loaded, driven by
Playwright, against the sample app served from the same machine. Raw output is in
[`docs/data`](data). Each section says how to run it again.

One machine, a local server, a small sample app, sessions I scripted. The numbers show how
the design behaves and roughly what it costs; they are not a benchmark of every app.

## 1. What a request costs

`npx tsx scripts/measure.ts`. Three hundred requests one after another from inside the page,
each timed from the call to the complete body.

```
   no extension                                 median   0.70 ms   p95   1.20 ms
   Blackbox on, mode off                        median   0.70 ms   p95   1.40 ms
   recording                                    median   2.00 ms   p95   5.40 ms
   replaying (no network)                       median   0.10 ms   p95   0.20 ms
```

- **Switched on but idle costs nothing measurable.** The patched `fetch` hands straight to
  the real one.
- **Recording adds about a millisecond.** Across three runs of this script the median
  difference was 1.0, 0.9 and 1.3 ms. The response itself is not delayed: it goes back to the
  page at once and a clone is read afterwards. The cost is building the request description
  and the clone, and the work of reporting each exchange competing for the same thread.
- **A replayed answer takes 0.1 ms**, since nothing leaves the page.

## 2. What it costs at page start

The interceptor holds a page's first requests until it has been told the site's mode. Twenty
reloads, timed from the start of navigation to the task list appearing:

```
   no extension                                 median   9.60 ms   p95  11.20 ms
   Blackbox on, mode off                        median  15.80 ms   p95  25.20 ms
   recording                                    median  19.60 ms   p95  42.20 ms
   replaying, backend switched off              median  13.30 ms   p95  39.70 ms
```

About 6 ms at the median for being switched on: two scripts injected, one read of extension
storage, one message between them. A site that is not turned on has nothing injected and
pays nothing.

**Before and after reading the mode from storage.** The bridge first asked the background
worker for the mode. The same measurement then:

| | Asking the worker | Reading storage |
| --- | --- | --- |
| Mode off | 15.3 ms | 14.2 – 15.8 ms |
| Recording | 29.7 ms (p95 75 ms) | 16.9 – 19.6 ms (p95 34 – 42 ms) |
| Replaying | 22.6 ms | 13.3 – 13.4 ms |

With the mode off there was little to gain. While recording or replaying, the worker is busy
storing exchanges or loading the recording, and a page start that waited on it waited behind
that work.

`npx tsx scripts/cold-start.ts` measures the case the change was made for, Chrome having
stopped the worker before the page loads (mode off, 15 reloads each):

| | Worker awake | Worker stopped |
| --- | --- | --- |
| Asking the worker | 15.9 ms | 22.8 ms |
| Reading storage | 14.8 and 18.0 ms | 20.0 and 19.7 ms |

These runs are noisy at this scale, and a stopped worker still costs something: Chrome
starts it on navigation for other reasons. The gap between the two columns went from about
7 ms to between 2 and 5.

## 3. Does a replay show what the live session showed?

Eight different sessions of the sample app. For each: record it from page load; switch the
server off; replay it and repeat the same actions; compare everything the visitor can see
(profile, every task and its tick, the streamed summary, the status line, any error) after
every step. Then the same with every request given its *first* recorded answer, which is how
simple mocks behave.

```
   session                                  requests   ordered answers   always the first answer
   look, then leave                                3   same              same
   add one task                                    5   same              different
   add, tick, delete, summarise                   10   same              different
   tick and untick the same task                   9   same              different
   three adds, summarise between each             11   same              different
   empty the list                                 10   same              different
   change, reload the page, change again           9   same              different
   same change twice                               9   same              different
   identical to the live session: 8 of 8 with ordered answers, 1 of 8 with always-the-first
```

First-answer replay survives only the session that changes nothing. Every other session
fetches the list again after a change and is shown the list from before it.

**The first run of this had 7 of 8.** "Change, reload the page, change again" differed: the
position in the recording lived in the page's memory, and the reload reset it. It is now kept
in `sessionStorage` under a session id (decision 5), and that session matches.

During every replay, no request reached the switched-off server.

## 4. Replaying a different session from the one recorded

A replay follows the recording, not the app's logic. Recorded: add "Buy milk", then tick
"Renew passport". Replayed: the tick first, then the add.

```
   a real backend would show, after the tick:  [x] Book train tickets | [x] Renew passport | [ ] Call the electrician
   after the tick, the list shows:  [x] Book train tickets | [ ] Renew passport | [ ] Call the electrician | [ ] Buy milk
   after the add, the list shows:   [x] Book train tickets | [x] Renew passport | [ ] Call the electrician | [ ] Buy milk
   then a task that was never recorded: the app shows an error
```

After the tick, the app asks for the list and is given the next list in the recording, which
is the one from after the *add*: wrong for what was just done. After both actions the lists
agree again. A request that was never recorded fails, and the panel names it. This is the
limit of the approach, and why the README says "a recording, not a simulation".

## 5. Real sites

`npx tsx scripts/real-sites.ts`. Four deployed sites of mine. The extension asks for
permission with a browser prompt that automation cannot click, so here the same interceptor
is injected by the test harness, before the page's scripts, where the extension puts it.
Each site is visited and recorded; then visited again in a fresh browser with every `fetch`
and `XMLHttpRequest` aborted at the network, answering from the recording; then what the
visitor could read is compared.

| Site | Recorded | Replay | What the visitor could read |
| --- | --- | --- | --- |
| Tollgate dashboard (React; a streamed POST) | 3 calls | 3 answered, 0 missed | identical |
| CodePilot demo (React; static JSON) | 1 call | 1 answered, 0 missed | identical |
| Portfolio (Next.js; client-side navigation) | 10 calls | 5 answered, 7 missed | identical |
| Lineless (React; live queue over WebSocket) | 1 call, and 2 WebSockets | 1 answered | identical, but see below |

No blocked request was needed in any of them: nothing reached the network.

- **Next.js prefetches speculatively.** It fetches data for links as they scroll into view,
  and which links those are differs between visits. Seven prefetches in the replay were for
  pages the recorded visit never prefetched, and had no answer. The framework treats a failed
  prefetch as nothing lost, and the navigation that was actually made was answered from the
  recording.
- **WebSockets are not intercepted.** Lineless matched only because its sockets still
  reached the real server, which the blocking in this script does not cover. With the
  backend truly gone, its live queue would not have loaded.

## 6. Size

The script injected into a page is 14.7 KB; the bridge beside it 1.0 KB; the background
worker 6.2 KB. The extension, panel included, is about 330 KB unpacked.
