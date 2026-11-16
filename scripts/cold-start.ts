import { launch, turnOn } from "../e2e/harness";
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0;
const rig = await launch();
await rig.app.addInitScript(() => {
  new MutationObserver((_, o) => { if (document.querySelector("#tasks li")) { (window as any).__listAt = performance.now(); o.disconnect(); } }).observe(document, { childList: true, subtree: true });
});
await turnOn(rig);
const client = await rig.context.newCDPSession(rig.app);
await client.send("ServiceWorker.enable");
const run = async (cold: boolean, n: number) => {
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    if (cold) { await client.send("ServiceWorker.stopAllWorkers"); await new Promise((r) => setTimeout(r, 300)); }
    await rig.app.reload();
    await rig.app.locator("#tasks li").first().waitFor();
    times.push(await rig.app.evaluate(() => (window as any).__listAt));
  }
  return times;
};
const warm = await run(false, 15), cold = await run(true, 15);
console.log("mode off, worker awake:   median", median(warm).toFixed(1), "ms  max", Math.max(...warm).toFixed(1));
console.log("mode off, worker stopped: median", median(cold).toFixed(1), "ms  max", Math.max(...cold).toFixed(1));
await rig.close();
