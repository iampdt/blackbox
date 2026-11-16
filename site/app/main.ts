// A small task list that talks to a real API in the three ways web apps do: fetch, a
// streamed fetch, and XMLHttpRequest. It is the thing Blackbox is demonstrated on.

import "./app.css";

interface Task {
  id: number | string;
  title: string;
  done?: boolean;
  completed?: boolean;
}

const session = (() => {
  const existing = sessionStorage.getItem("demo-session");
  if (existing) return existing;
  const made = crypto.randomUUID();
  sessionStorage.setItem("demo-session", made);
  return made;
})();
const flag = (name: string) => sessionStorage.getItem(name) === "1";
const headers = (): Record<string, string> => ({
  "x-demo-session": session,
  ...(flag("demo-outage") && { "x-demo-outage": "1" }),
  ...(flag("demo-v2") && { "x-demo-api": "v2" }),
});

const root = document.getElementById("app") as HTMLElement;
root.innerHTML = `
  <header>
    <h1>Tasks</h1>
    <p id="profile" class="muted">Loading profile…</p>
  </header>
  <p id="error" role="alert" hidden></p>
  <form id="add">
    <label class="sr-only" for="title">New task</label>
    <input id="title" name="title" maxlength="120" placeholder="Add a task" autocomplete="off" required />
    <button type="submit">Add</button>
  </form>
  <ul id="tasks" aria-label="Tasks" aria-live="polite"></ul>
  <section class="assistant">
    <button type="button" id="ask">Summarise my day</button>
    <p id="answer" class="muted" aria-live="polite"></p>
  </section>
  <footer>
    <button type="button" id="health">Check backend</button>
    <span id="status" class="muted" aria-live="polite"></span>
    <label><input type="checkbox" id="outage" /> Simulate a backend outage</label>
    <label><input type="checkbox" id="v2" /> Serve version 2 of the API (different field names and types)</label>
  </footer>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const errorBox = $("error");
const list = $<HTMLUListElement>("tasks");

function fail(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
}
function ok(): void {
  errorBox.hidden = true;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { ...headers(), ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  if (!response.ok) throw new Error(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `The server answered ${response.status}.`);
  return (response.status === 204 ? null : await response.json()) as T;
}

function render(tasks: Task[]): void {
  list.replaceChildren(
    ...tasks.map((task) => {
      const done = task.done ?? task.completed ?? false;
      const item = document.createElement("li");
      item.dataset.id = String(task.id);
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: done });
      box.setAttribute("aria-label", `Done: ${task.title}`);
      box.addEventListener("change", () => void act(() => api(`/api/tasks/${task.id}`, { method: "PATCH", body: JSON.stringify({ done: box.checked }) })));
      const title = Object.assign(document.createElement("span"), { textContent: task.title, className: done ? "done" : "" });
      const remove = Object.assign(document.createElement("button"), { type: "button", textContent: "Delete" });
      remove.setAttribute("aria-label", `Delete: ${task.title}`);
      remove.addEventListener("click", () => void act(() => api(`/api/tasks/${task.id}`, { method: "DELETE" })));
      item.append(box, title, remove);
      return item;
    }),
  );
  if (tasks.length === 0) list.append(Object.assign(document.createElement("li"), { textContent: "No tasks.", className: "muted" }));
}

async function load(): Promise<void> {
  render(await api<Task[]>("/api/tasks"));
  ok();
}

/** Do something, then fetch the list again: the same GET, with a different answer each time. */
async function act(change: () => Promise<unknown>): Promise<void> {
  try {
    await change();
    await load();
  } catch (failure) {
    fail(failure instanceof Error ? failure.message : "The request failed.");
  }
}

$<HTMLFormElement>("add").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $<HTMLInputElement>("title");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  void act(() => api("/api/tasks", { method: "POST", body: JSON.stringify({ title }) }));
});

// The profile is fetched the old way, with XMLHttpRequest, as plenty of apps and libraries still do.
function loadProfile(): void {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/api/profile");
  for (const [name, value] of Object.entries(headers())) xhr.setRequestHeader(name, value);
  xhr.responseType = "json";
  xhr.onload = () => {
    const profile = xhr.response as { name?: string; plan?: string } | null;
    $("profile").textContent = xhr.status === 200 && profile ? `${profile.name} · ${profile.plan} plan` : "Profile unavailable";
  };
  xhr.onerror = () => ($("profile").textContent = "Profile unavailable");
  xhr.send();
}

// A streamed answer, read piece by piece like a chat reply.
$("ask").addEventListener("click", async () => {
  const answer = $("answer");
  answer.textContent = "";
  try {
    const response = await fetch("/api/assistant", { method: "POST", headers: headers() });
    if (!response.ok || !response.body) throw new Error(`The server answered ${response.status}.`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const data = buffer.slice(0, end).replace(/^data:\s*/, "");
        buffer = buffer.slice(end + 2);
        if (data && data !== "[DONE]") answer.textContent += (JSON.parse(data) as { text: string }).text;
      }
    }
    answer.dataset.complete = "true";
    ok();
  } catch (failure) {
    fail(failure instanceof Error ? failure.message : "The request failed.");
  }
});

// A cache-buster on the URL, different every time, the way many apps defeat caches.
$("health").addEventListener("click", async () => {
  const status = $("status");
  try {
    const health = await api<{ tasks: number }>(`/api/health?_=${Date.now()}`);
    status.textContent = `Backend is up (${health.tasks} tasks stored).`;
    ok();
  } catch (failure) {
    status.textContent = "Backend is not answering.";
    fail(failure instanceof Error ? failure.message : "The request failed.");
  }
});

for (const [id, key] of [
  ["outage", "demo-outage"],
  ["v2", "demo-v2"],
] as const) {
  const box = $<HTMLInputElement>(id);
  box.checked = flag(key);
  box.addEventListener("change", () => {
    sessionStorage.setItem(key, box.checked ? "1" : "0");
    void act(async () => undefined);
  });
}

loadProfile();
void act(async () => undefined);
