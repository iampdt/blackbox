// Removing secrets from a recording before it leaves the machine.
//
// A recording kept in the browser is stored as it was captured, because replay has to hand
// the page exactly what the server sent (a redacted login token would break the app). What is
// exported to a file is redacted by default: recordings get committed, attached to bug
// reports and pasted into chats.

import { bodyText, header } from "./body";
import { canonicalJson } from "./match";
import type { Body, Exchange, HeaderList, Recording } from "./types";

export const REDACTED = "[redacted]";

const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;
const SECRET_NAMES = /(pass(word|wd)?|secret|token|api[-_]?key|access[-_]?key|auth|credential|session[-_]?id|signature|private[-_]?key|client[-_]?secret|otp|cvv|ssn)/i;
/** Three base64url parts separated by dots, the first starting like an encoded JSON object. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function redactHeaders(headers: HeaderList): HeaderList {
  return headers.map(([name, value]) => [name, SECRET_HEADERS.test(name) ? REDACTED : scrubText(value)]);
}

export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let changed = false;
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_NAMES.test(name)) {
      parsed.searchParams.set(name, REDACTED);
      changed = true;
    }
  }
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
    changed = true;
  }
  return changed ? parsed.toString().replace(/%5Bredacted%5D/gi, REDACTED) : url;
}

function scrubText(text: string): string {
  return text.replace(JWT, REDACTED).replace(BEARER, (_, scheme: string) => `${scheme} ${REDACTED}`);
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, SECRET_NAMES.test(key) && (typeof inner === "string" || typeof inner === "number") ? REDACTED : redactJson(inner)]),
    );
  }
  return typeof value === "string" ? scrubText(value) : value;
}

export function redactBody(body: Body, contentType: string | undefined): Body {
  if (body.kind !== "text") return body;
  const text = bodyText(body);
  let out: string;
  if (/json/i.test(contentType ?? "") || /^\s*[[{]/.test(text)) {
    try {
      out = JSON.stringify(redactJson(JSON.parse(text)));
      // Leave the text alone when nothing was redacted, so formatting survives.
      if (canonicalJson(JSON.parse(out), new Set()) === canonicalJson(JSON.parse(text), new Set())) return body;
    } catch {
      out = scrubText(text);
    }
  } else if (/x-www-form-urlencoded/i.test(contentType ?? "")) {
    const params = new URLSearchParams(text);
    for (const name of [...params.keys()]) if (SECRET_NAMES.test(name)) params.set(name, REDACTED);
    out = params.toString().replace(/%5Bredacted%5D/gi, REDACTED);
  } else {
    out = scrubText(text);
  }
  return out === text ? body : { ...body, data: out };
}

export function redactExchange(exchange: Exchange): Exchange {
  const request = {
    ...exchange.request,
    url: redactUrl(exchange.request.url),
    headers: redactHeaders(exchange.request.headers),
    body: redactBody(exchange.request.body, header(exchange.request.headers, "content-type")),
  };
  if (!exchange.response) return { ...exchange, request };
  const type = header(exchange.response.headers, "content-type");
  const body = redactBody(exchange.response.body, type);
  return {
    ...exchange,
    request,
    response: {
      ...exchange.response,
      headers: redactHeaders(exchange.response.headers),
      body,
      // The pieces of a stream are dropped if redaction changed its text: they no longer add up to it.
      chunks: body === exchange.response.body ? exchange.response.chunks?.map((chunk) => ({ ...chunk, data: scrubText(chunk.data) })) : undefined,
    },
  };
}

export function redactRecording(recording: Recording): Recording {
  return { ...recording, exchanges: recording.exchanges.map(redactExchange) };
}
