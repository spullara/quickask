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

function gemini(env: WorkerEnv, msgs: Msg[]) {
  return fetch(GEMINI, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: `Today is ${new Date().toUTCString()}. Lead with the direct answer in the first sentence. Keep it short; add detail only when it helps. Use Markdown.` }],
      },
      contents: msgs.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      tools: [{ google_search: {} }],
      generationConfig: { thinkingConfig: { thinkingLevel: "minimal" } },
    }),
  });
}

/** Read Gemini SSE and call onText for each text delta. Returns the full text and the search sources. */
async function relay(upstream: Promise<Response>, onText: (t: string) => void) {
  const res = await upstream;
  if (!res.ok || !res.body) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const sources = new Map<string, Source>();
  let text = "", buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const c = JSON.parse(line.slice(5)).candidates?.[0];
      for (const p of c?.content?.parts ?? []) {
        if (p.text && !p.thought) {
          text += p.text;
          onText(p.text);
        }
      }
      for (const g of c?.groundingMetadata?.groundingChunks ?? []) {
        if (g.web?.uri) sources.set(g.web.uri, { title: g.web.title ?? g.web.uri, uri: g.web.uri });
      }
    }
  }
  return { text, sources: [...sources.values()] };
}

function stream() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  return { readable, send: (s: string) => void writer.write(enc.encode(s)), close: () => writer.close() };
}

const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const titleOf = (q: string) => (q.length > 80 ? q.slice(0, 77) + "…" : q);

/** Image URLs for a query from Exa. Runs in parallel with the model, so it adds nothing to time to first token. */
async function images(env: WorkerEnv, query: string): Promise<string[]> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.EXA_API_KEY },
    body: JSON.stringify({ query, type: "fast", numResults: 8, contents: { extras: { imageLinks: 2 } } }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: { image?: string; extras?: { imageLinks?: string[] } }[] };
  // Each page's share image is the best signal; in-page images (often sliders and ads) come second, one per page.
  const ranked = [...(data.results ?? []).map((r) => r.image), ...(data.results ?? []).map((r) => r.extras?.imageLinks?.[0])];
  const out = new Set<string>();
  for (const u of ranked) {
    if (u?.startsWith("https://") && !/\.svg(\?|$)|\/\d{1,2}px-|logo|icon|favicon|sprite|avatar|badge|banner|slide|promo|hiring|advert/i.test(u)) out.add(u);
  }
  return [...out].slice(0, 8);
}

type Emit = (type: "T" | "I" | "D" | "E", value: unknown) => void;

/** One answer turn as events: T text delta, I images, D done with sources, E error. Returns what to save. */
async function turn(upstream: Promise<Response>, pics: Promise<string[]>, emit: Emit) {
  const shown = pics.then((i) => (i.length && emit("I", i), i), () => [] as string[]);
  try {
    const result = await relay(upstream, (t) => emit("T", t));
    const images = await shown;
    emit("D", result.sources);
    return { ...result, images };
  } catch (e) {
    await shown;
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
      return new Response(opensearch(url.origin), { headers: { "content-type": "application/opensearchdescription+xml" } });
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

    // Start the model call and the image search before any other work: they are the critical path.
    const msgs: Msg[] = q ? [{ role: "user", text: q }] : [];
    const upstream = q ? gemini(env, msgs) : null;
    const pics = q ? images(env, q) : null;
    const chats = env.CHATS.get(env.CHATS.idFromName(user.u));

    // New chat from the search box: one response carries the page and the streamed answer.
    if (path === "/" && upstream && pics && q) {
      const id = newId(), title = titleOf(q);
      const list = chats.list();
      const out = stream();
      out.send(shell({ id, title, msgs, streaming: true, user }));
      ctx.waitUntil((async () => {
        list.then((l) => out.send(call("L", l)), () => {});
        const result = await turn(upstream, pics, (t, v) => out.send(call(t, v)));
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
      const last = body.msgs.at(-1)?.text ?? "";
      const out = stream();
      ctx.waitUntil((async () => {
        const result = await turn(gemini(env, body.msgs), images(env, last),
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
