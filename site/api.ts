// The sample app's API. One function, used by the Cloudflare Worker that serves the public
// demo and by the local server the browser tests run against, so both behave identically.
//
// It is deliberately a real API with real state: the same request gets different answers
// before and after a change, which is the thing a replay has to get right.

export interface Task {
  id: number;
  title: string;
  done: boolean;
}

export interface AppState {
  tasks: Task[];
  nextId: number;
}

export function freshState(): AppState {
  return {
    tasks: [
      { id: 1, title: "Book train tickets", done: true },
      { id: 2, title: "Renew passport", done: false },
      { id: 3, title: "Call the electrician", done: false },
    ],
    nextId: 4,
  };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

/** What the "new version" of the API returns: same data, different shape. For the compare demo. */
const v2 = (task: Task) => ({ id: String(task.id), title: task.title, completed: task.done, updatedAt: new Date().toISOString() });

export function summary(state: AppState): string {
  const open = state.tasks.filter((task) => !task.done);
  if (state.tasks.length === 0) return "Your list is empty. Add a task to get started.";
  if (open.length === 0) return `All ${state.tasks.length} tasks are done. Nothing left for today.`;
  return `You have ${state.tasks.length} tasks and ${open.length} still to do. Start with "${open[0]?.title}"${open[1] ? `, then "${open[1].title}"` : ""}. ${state.tasks.length - open.length} already done.`;
}

export interface ApiOptions {
  /** Milliseconds between the words of a streamed answer. */
  wordDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Answers a request under /api, changing `state` as it goes. Null for any other path. */
export async function handleApi(request: Request, state: AppState, options: ApiOptions = {}): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  // The demo's two switches travel as headers, so the page decides and the server stays stateless about them.
  if (request.headers.get("x-demo-outage") === "1") return json({ error: "The backend is down (simulated)." }, 503);
  const shape: (task: Task) => unknown = request.headers.get("x-demo-api") === "v2" ? v2 : (task) => task;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health") return json({ ok: true, tasks: state.tasks.length });
  if (path === "/api/profile") return json({ name: "Demo visitor", plan: "free", sessionStarted: true });

  if (path === "/api/tasks" && method === "GET") return json(state.tasks.map(shape));
  if (path === "/api/tasks" && method === "POST") {
    const body = (await request.json().catch(() => null)) as { title?: unknown } | null;
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 120) : "";
    if (!title) return json({ error: "A task needs a title." }, 400);
    if (state.tasks.length >= 50) return json({ error: "This demo list holds 50 tasks." }, 400);
    const task: Task = { id: state.nextId++, title, done: false };
    state.tasks.push(task);
    return json(shape(task), 201);
  }

  const id = Number(/^\/api\/tasks\/(\d+)$/.exec(path)?.[1]);
  if (id) {
    const task = state.tasks.find((candidate) => candidate.id === id);
    if (!task) return json({ error: "No such task." }, 404);
    if (method === "PATCH") {
      const body = (await request.json().catch(() => null)) as { done?: unknown } | null;
      if (typeof body?.done === "boolean") task.done = body.done;
      return json(shape(task));
    }
    if (method === "DELETE") {
      state.tasks = state.tasks.filter((candidate) => candidate.id !== id);
      return new Response(null, { status: 204 });
    }
  }

  if (path === "/api/assistant" && method === "POST") {
    const words = summary(state).split(/(?<= )/);
    const delay = options.wordDelayMs ?? 45;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const word of words) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: word })}\n\n`));
          await sleep(delay);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
  }

  if (path === "/api/reset" && method === "POST") {
    Object.assign(state, freshState());
    return json({ reset: true });
  }
  return json({ error: "Not found." }, 404);
}
