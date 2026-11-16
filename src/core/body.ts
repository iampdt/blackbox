// Turning bytes into a recorded Body and back.

import type { Body, HeaderList } from "./types";

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|x-ndjson|problem\+json|ld\+json)|[^;]*\+(json|xml))/i;

export function header(headers: HeaderList, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lower)?.[1];
}

export function isTextType(contentType: string | undefined): boolean {
  return !!contentType && (TEXT_TYPES.test(contentType.trim()) || /event-stream/i.test(contentType));
}

/** True for bytes that decode as UTF-8 without replacement characters or control bytes. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 2048);
  for (const byte of sample) if (byte === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
    return true;
  } catch {
    return false;
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const NO_BODY: Body = { kind: "none", data: "", size: 0 };

export function bodyFromBytes(bytes: Uint8Array, contentType: string | undefined, maxBytes: number): Body {
  if (bytes.length === 0) return NO_BODY;
  const truncated = bytes.length > maxBytes;
  const kept = truncated ? bytes.subarray(0, maxBytes) : bytes;
  const text = isTextType(contentType) || (!contentType && looksLikeText(kept));
  return {
    kind: text ? "text" : "base64",
    data: text ? new TextDecoder().decode(kept) : toBase64(kept),
    size: bytes.length,
    ...(truncated && { truncated: true }),
  };
}

export function bodyFromText(text: string, maxBytes: number): Body {
  if (text.length === 0) return NO_BODY;
  // A string of n characters is at least n bytes; only measure exactly when it might matter.
  if (text.length * 3 <= maxBytes) return { kind: "text", data: text, size: new TextEncoder().encode(text).length };
  return bodyFromBytes(new TextEncoder().encode(text), "text/plain", maxBytes);
}

export function bodyBytes(body: Body): Uint8Array<ArrayBuffer> {
  if (body.kind === "none") return new Uint8Array(0);
  return body.kind === "text" ? new TextEncoder().encode(body.data) : fromBase64(body.data);
}

export function bodyText(body: Body): string {
  if (body.kind === "none") return "";
  return body.kind === "text" ? body.data : new TextDecoder().decode(fromBase64(body.data));
}
