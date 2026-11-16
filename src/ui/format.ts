import { bodyText, header } from "../core/body";
import type { Body, Exchange, HeaderList } from "../core/types";

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10_240 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function ms(value: number): string {
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

export function pathOf(url: string, pageOrigin: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname}${parsed.search}`;
    return parsed.origin === pageOrigin ? rest : `${parsed.host}${rest}`;
  } catch {
    return url;
  }
}

export function kindOf(exchange: Exchange): string {
  const type = exchange.response ? (header(exchange.response.headers, "content-type") ?? "") : "";
  if (exchange.response?.chunks) return "stream";
  const short = type.split(";")[0]?.split("/").pop() ?? "";
  return short.replace(/^x-/, "").replace(/\+.*$/, "") || "–";
}

/** A body as something to read: JSON indented, text as it is, binary described. */
export function readable(body: Body, headers: HeaderList): { text: string; note: string | null } {
  if (body.kind === "none") return { text: "", note: "No body" };
  const cut = body.truncated ? `Only the first ${bytes(body.data.length)} of ${bytes(body.size)} were kept.` : null;
  if (body.kind === "base64") return { text: "", note: `Binary, ${bytes(body.size)}${header(headers, "content-type") ? ` (${header(headers, "content-type")})` : ""}. ${cut ?? ""}`.trim() };
  const text = bodyText(body);
  if (/json/i.test(header(headers, "content-type") ?? "") || /^\s*[[{]/.test(text)) {
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), note: cut };
    } catch {
      // Show it as it is.
    }
  }
  return { text, note: cut };
}

export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "recording";
