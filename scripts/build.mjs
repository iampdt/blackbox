// Builds the extension into dist/extension: the scripts with esbuild (each has to be one
// self-contained file), the panel and popup with Vite.

import { build as esbuild } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { build as vite } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/extension");

/** A PNG of the icon, drawn here so the repository holds no binary files: a dark rounded square with a red "recording" dot. */
function icon(size) {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const radius = size * 0.22;
  const dot = size * 0.2;
  for (let y = 0; y < size; y++) {
    pixels[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const cx = Math.max(radius - x - 0.5, 0, x + 0.5 - (size - radius));
      const cy = Math.max(radius - y - 0.5, 0, y + 0.5 - (size - radius));
      const inside = Math.hypot(cx, cy) <= radius;
      const inDot = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= dot;
      const ring = Math.abs(Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) - size * 0.34) <= Math.max(0.7, size * 0.035);
      const [r, g, b] = inDot ? [208, 59, 59] : ring ? [240, 239, 236] : [11, 11, 11];
      pixels.set([r, g, b, inside ? 255 : 0], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = ~0;
    for (const byte of body) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(~crc >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "icons"), { recursive: true });

const script = (entry, file, format) => esbuild({ entryPoints: [resolve(root, entry)], outfile: resolve(out, file), bundle: true, format, target: "chrome111", minify: true, legalComments: "none", logLevel: "warning" });
await Promise.all([
  script("src/extension/background.ts", "background.js", "esm"),
  script("src/extension/page.ts", "page.js", "iife"),
  script("src/extension/bridge.ts", "bridge.js", "iife"),
  script("src/extension/devtools.ts", "devtools.js", "iife"),
]);

await vite({
  root: resolve(root, "src/ui"),
  base: "./",
  configFile: false,
  logLevel: "warn",
  plugins: [react(), tailwindcss()],
  build: { outDir: out, emptyOutDir: false, rollupOptions: { input: { panel: resolve(root, "src/ui/panel.html"), popup: resolve(root, "src/ui/popup.html") } } },
});

await cp(resolve(root, "src/extension/manifest.json"), resolve(out, "manifest.json"));
await cp(resolve(root, "src/ui/devtools.html"), resolve(out, "devtools.html"));
for (const size of [16, 48, 128]) await writeFile(resolve(out, `icons/${size}.png`), icon(size));
console.log("built dist/extension");

// ── The demo site: the landing page with the live demo, and the sample app ──
const site = resolve(root, "dist/site");
await rm(site, { recursive: true, force: true });
await vite({
  root: resolve(root, "site"),
  publicDir: resolve(root, "public"),
  configFile: false,
  logLevel: "warn",
  plugins: [react(), tailwindcss()],
  build: { outDir: site, emptyOutDir: true, rollupOptions: { input: { index: resolve(root, "site/index.html"), app: resolve(root, "site/app/index.html") } } },
});
await esbuild({ entryPoints: [resolve(root, "site/embed.ts")], outfile: resolve(site, "embed.js"), bundle: true, format: "iife", target: "es2022", minify: true, legalComments: "none", logLevel: "warning" });
console.log("built dist/site");
