// The demo site's Worker. Static files are served by the platform; requests under /api go
// to the sample app's API, with one small stateful object per visitor session so that each
// visitor has their own task list.

import { DurableObject } from "cloudflare:workers";
import { type AppState, freshState, handleApi } from "../api";

interface Env {
  SESSIONS: DurableObjectNamespace<Session>;
}

export class Session extends DurableObject<Env> {
  private state: AppState | null = null;

  override async fetch(request: Request): Promise<Response> {
    this.state ??= (await this.ctx.storage.get<AppState>("state")) ?? freshState();
    const response = (await handleApi(request, this.state)) ?? new Response("Not found", { status: 404 });
    if (request.method !== "GET") {
      await this.ctx.storage.put("state", this.state);
      // A visitor's list is forgotten a day after they last changed it.
      await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
    }
    return response;
  }

  override async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.state = null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const session = (request.headers.get("x-demo-session") ?? "").slice(0, 64);
    // A session id is a random UUID made by the app. Anything else shares one list.
    const name = /^[0-9a-f-]{36}$/i.test(session) ? session : "shared";
    return env.SESSIONS.get(env.SESSIONS.idFromName(name)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
