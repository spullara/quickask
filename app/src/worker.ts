import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";
import { cookie, session } from "./session.ts";
import { call, keyPage, opensearch, shell, signIn, type Msg, type Source } from "./page.ts";

export { Auth } from "./auth-store.ts";

const MODEL = "gemini-3.5-flash-lite";
const GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

export class Chats extends DurableObject<WorkerEnv> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, updated INTEGER, msgs TEXT)");
  }

  list() {
    return this.sql.exec<{ id: string; title: string }>("SELECT id, title FROM chats ORDER BY updated DESC LIMIT 300").toArray();
  }

  get(id: string) {
    const row = this.sql.exec<{ title: string; msgs: string }>("SELECT title, msgs FROM chats WHERE id = ?", id).toArray()[0];
    return row ? { id, title: row.title, msgs: JSON.parse(row.msgs) as Msg[] } : null;
  }

  save(id: string, title: string, msgs: Msg[]) {
    this.sql.exec(
      "INSERT INTO chats VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated = excluded.updated, msgs = excluded.msgs",
      id, title, Date.now(), JSON.stringify(msgs),
    );
  }

  remove(id: string) {
    this.sql.exec("DELETE FROM chats WHERE id = ?", id);
  }
}

const SYSTEM = `You are a fast answer engine. Answer the latest question, using the search results when they are relevant.
Lead with the direct answer in the first sentence. Keep it short; add detail only when it helps. Use Markdown.
Images: a search result can list image ids (img:N) from its page. When pictures would really help (people, places, products,
animals, artworks, how something looks), put 1 to 3 of the most relevant on their own line as ![short caption](img:N).
Use only listed ids. When pictures would not help, include none. Never write image URLs.
Results are sorted newest first and show publish dates. For questions about the latest, newest, current or most recent
anything, the most recently published reports decide the answer: lead with what they say, then mention older context.`;

/** Gemini with the search results attached to the latest question. No search tool: Exa already did the search. */
function gemini(env: WorkerEnv, msgs: Msg[], found: Search) {
  const results = found.context ? `<search_results>\n${found.context}\n</search_results>` : "(No search results.)";
  return fetch(GEMINI, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `Today is ${new Date().toUTCString()}.\n${SYSTEM}` }] },
      contents: msgs.map((m, i) => ({
        role: m.role,
        parts: [{ text: i === msgs.length - 1 ? `${m.text}\n\n${results}` : m.text }],
      })),
      generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
    }),
  });
}

/** Read Gemini SSE, call onText for each text delta, return the full text. */
async function relay(upstream: Promise<Response>, onText: (t: string) => void) {
  const res = await upstream;
  if (!res.ok || !res.body) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "", buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      for (const p of JSON.parse(line.slice(5)).candidates?.[0]?.content?.parts ?? []) {
        if (p.text && !p.thought) {
          text += p.text;
          onText(p.text);
        }
      }
    }
  }
  return text;
}

function stream() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  return { readable, send: (s: string) => void writer.write(enc.encode(s)), close: () => writer.close() };
}

const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const titleOf = (q: string) => (q.length > 80 ? q.slice(0, 77) + "…" : q);

type Search = { context: string; sources: Source[]; images: string[] };
type ExaResult = { url: string; title?: string; publishedDate?: string; highlights?: string[]; image?: string; extras?: { imageLinks?: string[] } };
const NOT_A_PHOTO = /\.svg(\?|$)|\/\d{1,2}px-|logo|icon|favicon|sprite|avatar|badge|banner|slide|promo|hiring|advert/i;

/** Exa search: the most query-relevant sentences of each page (anywhere in it, not just the top) for the model, plus each page's images as short ids (img:N) the model can place. */
async function search(env: WorkerEnv, query: string): Promise<Search> {
  try {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.EXA_API_KEY },
      body: JSON.stringify({ query, type: "fast", numResults: 10, contents: { highlights: { numSentences: 3, highlightsPerUrl: 3 }, extras: { imageLinks: 2 } } }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Exa ${res.status}`);
    const { results = [] } = (await res.json()) as { results?: ExaResult[] };
    results.sort((a, b) => (b.publishedDate ?? "").localeCompare(a.publishedDate ?? ""));
    const images: string[] = [], sources: Source[] = [], parts: string[] = [];
    results.forEach((r, i) => {
      const host = new URL(r.url).hostname.replace(/^www\./, "");
      sources.push({ title: host, uri: r.url });
      const ids: string[] = [];
      for (const u of [r.image, ...(r.extras?.imageLinks ?? [])]) {
        if (images.length < 12 && u?.startsWith("https://") && !NOT_A_PHOTO.test(u) && !images.includes(u)) ids.push(`img:${images.push(u)}`);
      }
      const date = r.publishedDate ? `, ${r.publishedDate.slice(0, 10)}` : "";
      parts.push(`[${i + 1}] ${r.title ?? host} (${host}${date})\n${(r.highlights ?? []).join(" … ")}${ids.length ? `\nImages: ${ids.join(", ")}` : ""}`);
    });
    return { context: parts.join("\n\n"), sources, images };
  } catch {
    return { context: "", sources: [], images: [] };
  }
}

/** Search text for a turn. A short follow-up ("what is her job?") gets the previous question for context. */
function queryOf(msgs: Msg[]) {
  const asked = msgs.filter((m) => m.role === "user").map((m) => m.text);
  const last = asked.at(-1) ?? "";
  return last.split(/\s+/).length < 8 && asked.length > 1 ? `${asked.at(-2)} ${last}` : last;
}

type Emit = (type: "T" | "I" | "D" | "E", value: unknown) => void;

/** One answer turn as events: I image ids, T text delta, D done with sources, E error. Returns what to save. */
async function turn(env: WorkerEnv, msgs: Msg[], searching: Promise<Search>, emit: Emit) {
  try {
    const found = await searching;
    if (found.images.length) emit("I", found.images);
    const text = await relay(gemini(env, msgs, found), (t) => emit("T", t));
    emit("D", found.sources);
    return { text, sources: found.sources, images: found.images };
  } catch (e) {
    emit("E", (e as Error).message);
    return null;
  }
}

export default {
  async fetch(req: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const q = url.searchParams.get("q")?.trim();

    if (path === "/opensearch.xml") {
      // text/xml displays inline; the OpenSearch type makes some browsers download the file.
      return new Response(opensearch(url.origin), { headers: { "content-type": "text/xml; charset=utf-8", "content-disposition": "inline" } });
    }
    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    const hasKey = cookie(req, "k") === env.ACCESS_KEY;
    const keyParam = url.searchParams.get("k") === env.ACCESS_KEY;
    if (!hasKey && !keyParam) return new Response(keyPage(url.searchParams.has("k")), { status: 401, headers: HTML });
    const headers: Record<string, string> = { ...HTML };
    if (keyParam && !hasKey) headers["set-cookie"] = `k=${env.ACCESS_KEY}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`;

    if (path.startsWith("/auth/")) {
      const res = await (await import("./auth.ts")).authRoute(req, env, url);
      if (res) return res;
    }
    const user = await session(req, env);
    if (!user) return new Response(signIn(), { headers });

    // Start the search before any other work: it is the first step of the critical path.
    const msgs: Msg[] = q ? [{ role: "user", text: q }] : [];
    const searching = q ? search(env, q) : null;
    const chats = env.CHATS.get(env.CHATS.idFromName(user.u));

    // New chat from the search box: one response carries the page and the streamed answer.
    if (path === "/" && searching && q) {
      const id = newId(), title = titleOf(q);
      const list = chats.list();
      const out = stream();
      out.send(shell({ id, title, msgs, streaming: true, user }));
      ctx.waitUntil((async () => {
        list.then((l) => out.send(call("L", l)), () => {});
        const result = await turn(env, msgs, searching, (t, v) => out.send(call(t, v)));
        await list.catch(() => {});
        await out.close();
        if (result) await chats.save(id, title, [...msgs, { role: "model", ...result }]);
      })());
      return new Response(out.readable, { headers });
    }

    if (path === "/") {
      const list = await chats.list();
      return new Response(shell({ id: null, title: "Quick", msgs: [], streaming: false, user }) + call("L", list), { headers });
    }

    const chatPage = path.match(/^\/c\/(\w+)$/);
    if (chatPage) {
      const [chat, list] = await Promise.all([chats.get(chatPage[1]!), chats.list()]);
      if (!chat) return Response.redirect(url.origin + "/", 302);
      return new Response(shell({ ...chat, streaming: false, user }) + call("L", list), { headers });
    }

    const api = path.match(/^\/api\/chats\/(\w+)$/);
    if (api && req.method === "POST") {
      // Follow-up: the client sends the history it already has, so no storage read is on the critical path.
      const body = (await req.json()) as { title: string; msgs: Msg[] };
      const searching = search(env, queryOf(body.msgs));
      const out = stream();
      ctx.waitUntil((async () => {
        const result = await turn(env, body.msgs, searching,
          (t, v) => out.send(t + (typeof v === "string" ? v : JSON.stringify(v)) + "\u0000"));
        await out.close();
        if (result) await chats.save(api[1]!, body.title, [...body.msgs, { role: "model", ...result }]);
      })());
      return new Response(out.readable, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (api && req.method === "DELETE") {
      await chats.remove(api[1]!);
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  },
};
