import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";
import { cookie, session } from "./session.ts";
import { PAGE_VERSION, adminPage, call, keyPage, opensearch, sharePage, shell, signIn, type Msg, type Result, type Source } from "./page.ts";
import { MODELS, modelKey, type Meter, type ModelKey } from "./usage.ts";

import { APPLE_ICON_PNG, FAVICON_PNG, LOGO_SVG } from "./icons.ts";

export { Auth } from "./auth-store.ts";
export { Usage } from "./usage.ts";

const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };

export class Chats extends DurableObject<WorkerEnv> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, updated INTEGER, msgs TEXT)");
    if (!this.sql.exec("SELECT 1 FROM pragma_table_info('chats') WHERE name = 'model'").toArray().length) {
      this.sql.exec("ALTER TABLE chats ADD COLUMN model TEXT");
    }
    // Keep-alive pings get an answer without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Live sidebar: open pages hold a hibernatable WebSocket and get the list whenever it changes. */
  override async fetch() {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ list: this.list() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  /** Send a message to every open page of this user. */
  broadcast(msg: object) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {}
    }
  }

  /** Push the list to every open page, with what changed so a page showing that chat can refresh it. */
  private notify(change: { changed: string; n: number; origin?: string } | { deleted: string }) {
    this.broadcast({ list: this.list(), ...change });
  }

  list() {
    return this.sql.exec<{ id: string; title: string }>("SELECT id, title FROM chats ORDER BY updated DESC LIMIT 300").toArray();
  }

  get(id: string) {
    const row = this.sql.exec<{ title: string; msgs: string; model: string | null }>("SELECT title, msgs, model FROM chats WHERE id = ?", id).toArray()[0];
    return row ? { id, title: row.title, msgs: JSON.parse(row.msgs) as Msg[], model: modelKey(row.model) } : null;
  }

  /** origin is the page that made the change, so it can skip the update it already has. */
  save(id: string, title: string, msgs: Msg[], model?: ModelKey, origin?: string) {
    this.sql.exec(
      `INSERT INTO chats (id, title, updated, msgs, model) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, updated = excluded.updated, msgs = excluded.msgs, model = COALESCE(excluded.model, chats.model)`,
      id, title, Date.now(), JSON.stringify(msgs), model ?? null,
    );
    this.notify({ changed: id, n: msgs.length, origin });
  }

  remove(id: string) {
    this.sql.exec("DELETE FROM chats WHERE id = ?", id);
    this.notify({ deleted: id });
  }
}

const SYSTEM = `You are a fast answer engine. Answer the latest question, using the search results when they are relevant.
Lead with the direct answer in the first sentence. Keep it short; add detail only when it helps. Use Markdown.
Cite the search results you use as [n] (their numbers) right after the sentence they support, for example [1] or [2, 5].
Images: a search result can list image ids (img:N) from its page. When pictures would really help (people, places,
landmarks, products, animals, artworks, how something looks), put 1 to 3 of the most relevant on their own line as
![short caption](img:N). Use only listed ids. When pictures would not help, include none. Never write image URLs.
Navigation: if the question is, or might be, an attempt to reach a site (a company, brand, product, app, service, login
page, documentation or homepage, such as "github", "chase login" or "react docs"), make the very first line only the most
likely official link from the results, as [Site name](url). Use a listed URL without its query string, or the site's root
(https://host/) when the results only show inner pages of that site. Then answer as usual below it, pictures included.
Results are sorted newest first and show publish dates. For questions about the latest, newest, current or most recent
anything, the most recently published reports decide the answer: lead with what they say, then mention older context.`;

/** Gemini with the search results attached to the latest question. No search tool: Exa already did the search. */
/** Read-only chat snapshots behind share links. One global instance. */
export class Shares extends DurableObject<WorkerEnv> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql.exec("CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, title TEXT, msgs TEXT, created INTEGER)");
    if (!this.sql.exec("SELECT name FROM pragma_table_info('shares') WHERE name = 'chat'").toArray().length) {
      this.sql.exec("ALTER TABLE shares ADD COLUMN chat TEXT");
    }
    this.sql.exec("CREATE INDEX IF NOT EXISTS shares_chat ON shares (chat)");
  }

  /** chat is "<user id>/<chat id>", so every change below is scoped to the owner. */
  put(id: string, chat: string, title: string, msgs: Msg[]) {
    const created = Date.now();
    this.sql.exec("INSERT INTO shares (id, title, msgs, created, chat) VALUES (?, ?, ?, ?, ?)", id, title, JSON.stringify(msgs), created, chat);
    return created;
  }

  list(chat: string) {
    return this.sql.exec<{ id: string; created: number }>("SELECT id, created FROM shares WHERE chat = ? ORDER BY created DESC", chat).toArray();
  }

  remove(chat: string, id?: string) {
    const gone = this.sql.exec<{ id: string }>(
      id ? "DELETE FROM shares WHERE chat = ? AND id = ? RETURNING id" : "DELETE FROM shares WHERE chat = ? RETURNING id",
      ...(id ? [chat, id] : [chat]),
    ).toArray();
    return gone.map((r) => r.id);
  }

  get(id: string) {
    const row = this.sql.exec<{ title: string; msgs: string }>("SELECT title, msgs FROM shares WHERE id = ?", id).toArray()[0];
    return row ? { title: row.title, msgs: JSON.parse(row.msgs) as Msg[] } : null;
  }
}

function gemini(env: WorkerEnv, msgs: Msg[], found: Search, model: ModelKey) {
  const results = found.context ? `<search_results>\n${found.context}\n</search_results>` : "(No search results.)";
  const m = MODELS[model];
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.id}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: `Today is ${new Date().toUTCString()}.\n${SYSTEM}` }] },
      contents: msgs.map((m, i) => ({
        role: m.role,
        parts: [{ text: i === msgs.length - 1 ? `${m.text}\n\n${results}` : m.text }],
      })),
      generationConfig: { thinkingConfig: { thinkingLevel: m.thinking } },
    }),
  });
}

/** Read Gemini SSE, call onText for each text delta. Returns the full text and the billed token counts. */
async function relay(upstream: Promise<Response>, onText: (t: string) => void) {
  const res = await upstream;
  if (!res.ok || !res.body) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let text = "", buf = "", tokensIn = 0, tokensOut = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const chunk = JSON.parse(line.slice(5));
      const u = chunk.usageMetadata;
      if (u) {
        tokensIn = u.promptTokenCount ?? tokensIn;
        tokensOut = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) || tokensOut;
      }
      for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (p.text && !p.thought) {
          text += p.text;
          onText(p.text);
        }
      }
    }
  }
  return { text, tokensIn, tokensOut };
}

function stream() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  // The page can go away mid-answer; ignore that so the answer is still saved and charged.
  return {
    readable,
    send: (s: string) => void writer.write(enc.encode(s)).catch(() => {}),
    close: () => writer.close().catch(() => {}),
  };
}

/** A chat as stored, waiting up to 3 s for a save still in flight to reach at least n messages. */
async function stored(chats: DurableObjectStub<Chats>, id: string, n: number) {
  let chat = await chats.get(id);
  for (let i = 0; i < 10 && (!chat || chat.msgs.length < n); i++) {
    await new Promise((r) => setTimeout(r, 300));
    chat = await chats.get(id);
  }
  return chat;
}

const shareKey = (origin: string, id: string) => new Request(`${origin}/s/${id}?v=${PAGE_VERSION}`);

/** The admin is the oldest account named ADMIN_NAME. Names are unique for new accounts, so it cannot be copied. */
let adminId: string | undefined;
async function adminIdOf(env: WorkerEnv) {
  if (env.ADMIN_NAME) adminId ??= (await env.AUTH.get(env.AUTH.idFromName("auth")).firstNamed(env.ADMIN_NAME)) ?? undefined;
  return adminId;
}
const isAdmin = async (env: WorkerEnv, user: string) => user === (await adminIdOf(env));

/** Record a turn's cost and push the new month total to the admin's open pages. Runs after the stream. */
async function charge(env: WorkerEnv, user: string, meter: Meter) {
  const month = await env.USAGE.get(env.USAGE.idFromName("global")).record(user, meter);
  const admin = await adminIdOf(env);
  if (admin) await env.CHATS.get(env.CHATS.idFromName(admin)).broadcast({ usage: month });
}

const png = (b64: string) => () => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const ICONS: Record<string, [() => string | Uint8Array<ArrayBuffer>, string]> = {
  "/icon.svg": [() => LOGO_SVG, "image/svg+xml"],
  "/favicon.ico": [png(FAVICON_PNG), "image/png"],
  "/apple-touch-icon.png": [png(APPLE_ICON_PNG), "image/png"],
};

const newId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const titleOf = (q: string) => (q.length > 80 ? q.slice(0, 77) + "…" : q);

type Search = { context: string; sources: Source[]; images: string[]; exa: number; results: Result[] };
type ExaResult = { url: string; title?: string; publishedDate?: string; highlights?: string[]; image?: string; extras?: { imageLinks?: string[] } };
const NOT_A_PHOTO = /\.svg(\?|$)|\/\d{1,2}px-|logo|icon|favicon|sprite|avatar|badge|banner|slide|promo|hiring|advert/i;

/** Exa search: the most query-relevant sentences of each page (anywhere in it, not just the top) for the model, plus each page's images as short ids (img:N) the model can place. */
async function search(env: WorkerEnv, query: string): Promise<Search> {
  try {
    // Global 10 searches/s limit. Over a 3 s queue, answer without search instead of making the user wait.
    const wait = await env.USAGE.get(env.USAGE.idFromName("global")).acquire();
    if (wait > 3000) throw new Error("Exa queue full");
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.EXA_API_KEY },
      body: JSON.stringify({ query, type: "fast", numResults: 10, contents: { highlights: { numSentences: 3, highlightsPerUrl: 3 }, extras: { imageLinks: 2 } } }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Exa ${res.status}`);
    const { results = [], costDollars } = (await res.json()) as { results?: ExaResult[]; costDollars?: { total?: number } };
    results.sort((a, b) => (b.publishedDate ?? "").localeCompare(a.publishedDate ?? ""));
    const images: string[] = [], sources: Source[] = [], parts: string[] = [], shown: Result[] = [];
    results.forEach((r, i) => {
      const host = new URL(r.url).hostname.replace(/^www\./, "");
      sources.push({ title: host, uri: r.url });
      const ids: string[] = [];
      for (const u of [r.image, ...(r.extras?.imageLinks ?? [])]) {
        if (images.length < 12 && u?.startsWith("https://") && !NOT_A_PHOTO.test(u) && !images.includes(u)) ids.push(`img:${images.push(u)}`);
      }
      const date = r.publishedDate ? `, ${r.publishedDate.slice(0, 10)}` : "";
      shown.push({ title: r.title ?? host, url: r.url, date: r.publishedDate?.slice(0, 10), text: plain((r.highlights ?? []).join(" … ")).slice(0, 600) });
      parts.push(`[${i + 1}] ${r.title ?? host} (${r.url}${date})\n${(r.highlights ?? []).join(" … ")}${ids.length ? `\nImages: ${ids.join(", ")}` : ""}`);
    });
    return { context: parts.join("\n\n"), sources, images, exa: costDollars?.total ?? 0, results: shown };
  } catch {
    return { context: "", sources: [], images: [], exa: 0, results: [] };
  }
}

/** Search text for a turn. A short follow-up ("what is her job?") gets the previous question for context. */
function queryOf(msgs: Msg[]) {
  const asked = msgs.filter((m) => m.role === "user").map((m) => m.text);
  const last = asked.at(-1) ?? "";
  return last.split(/\s+/).length < 8 && asked.length > 1 ? `${asked.at(-2)} ${last}` : last;
}

type Emit = (type: "T" | "I" | "R" | "D" | "E", value: unknown) => void;

/** Highlights are page Markdown; strip the marks for the search results panel. */
const plain = (t: string) => t.replace(/(^|\s)#{1,6}(?=\s|$)/g, "$1").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();

/** One answer turn as events: I image ids, T text delta, D done with sources, E error. Returns what to save and what it cost. */
async function turn(env: WorkerEnv, msgs: Msg[], searching: Promise<Search>, emit: Emit, model: ModelKey = "lite"): Promise<{ msg: Msg; meter: Meter } | null> {
  try {
    const found = await searching;
    if (found.images.length) emit("I", found.images);
    emit("R", found.results);
    const { text, tokensIn, tokensOut } = await relay(gemini(env, msgs, found, model), (t) => emit("T", t));
    emit("D", found.sources);
    const gemini$ = tokensIn * MODELS[model].in + tokensOut * MODELS[model].out;
    return { msg: { role: "model", text, sources: found.sources, images: found.images, results: found.results, model }, meter: { exa: found.exa, tokensIn, tokensOut, gemini: gemini$ } };
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
    const icon = ICONS[path];
    if (icon) return new Response(icon[0](), { headers: { "content-type": icon[1], "cache-control": "public, max-age=604800" } });

    // Share links are public: no access key, no account. The edge caches them for a minute, so a deleted link dies everywhere within a minute.
    if (path === "/robots.txt") return new Response("User-agent: *\nAllow: /s/\nDisallow: /\n", { headers: { "content-type": "text/plain" } });

    // Share card for link previews (X, iMessage, Slack): rendered by the separate card Worker, cached at the edge.
    const cardPath = path.match(/^\/s\/(\w+)\/card\.png$/);
    if (cardPath) {
      const key = new Request(`${url.origin}${path}?v=${PAGE_VERSION}`);
      const hit = await caches.default.match(key);
      if (hit) return hit;
      const snap = await env.SHARES.get(env.SHARES.idFromName("shares")).get(cardPath[1]!);
      if (!snap) return new Response("Not found", { status: 404 });
      let png: Response;
      try {
        png = await env.CARD.fetch("https://card/", {
          method: "POST",
          body: JSON.stringify({ question: snap.title, answer: snap.msgs.find((m) => m.role === "model")?.text ?? "", host: url.host }),
        });
      } catch {
        return new Response("Card failed", { status: 502 });
      }
      if (!png.ok) return new Response("Card failed", { status: 502 });
      const res = new Response(png.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=3600, s-maxage=3600" } });
      ctx.waitUntil(caches.default.put(key, res.clone()));
      return res;
    }

    const shared = path.match(/^\/s\/(\w+)$/);
    if (shared) {
      const key = shareKey(url.origin, shared[1]!);
      const hit = await caches.default.match(key);
      if (hit) return hit;
      const snap = await env.SHARES.get(env.SHARES.idFromName("shares")).get(shared[1]!);
      if (!snap) return new Response("This link does not exist.", { status: 404 });
      const res = new Response(sharePage(snap, `${url.origin}/s/${shared[1]}`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60, s-maxage=60" } });
      ctx.waitUntil(caches.default.put(key, res.clone()));
      return res;
    }

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
    const shares = env.SHARES.get(env.SHARES.idFromName("shares"));
    const usage = env.USAGE.get(env.USAGE.idFromName("global"));

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
        if (result) await Promise.all([chats.save(id, title, [...msgs, result.msg]), charge(env, user.u, result.meter)]);
      })());
      return new Response(out.readable, { headers });
    }

    if (path === "/") {
      const list = await chats.list();
      return new Response(shell({ id: null, title: "QuickAsk", msgs: [], streaming: false, user }) + call("L", list), { headers });
    }

    const chatPage = path.match(/^\/c\/(\w+)$/);
    if (chatPage) {
      const [chat, list, links] = await Promise.all([chats.get(chatPage[1]!), chats.list(), shares.list(`${user.u}/${chatPage[1]}`)]);
      if (!chat) return Response.redirect(url.origin + "/", 302);
      return new Response(shell({ ...chat, streaming: false, user, shares: links }) + call("L", list), { headers });
    }

    if (path === "/api/live") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return chats.fetch(req);
    }

    if (path === "/api/usage" || path === "/admin") {
      if (!(await isAdmin(env, user.u))) return new Response("Not found", { status: 404 });
      const month = new Date().toISOString().slice(0, 8) + "01", today = new Date().toISOString().slice(0, 10);
      if (path === "/api/usage") return Response.json({ month: (await usage.totals(month))[0] });
      const since = new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10);
      const [t, m, byUser, byDay, names] = await Promise.all([
        usage.totals(today), usage.totals(month), usage.totals(month, "user"), usage.totals(since, "day"),
        env.AUTH.get(env.AUTH.idFromName("auth")).names(),
      ]);
      return new Response(adminPage({ today: t[0]!, month: m[0]!, byUser, byDay, names }), { headers });
    }

    const share = path.match(/^\/api\/chats\/(\w+)\/share$/);
    if (share && req.method === "POST") {
      // Snapshot from storage, not from the client, so nobody can publish made-up answers on this domain.
      // The chat saves after its stream ends, so wait briefly when the newest answer is not stored yet.
      // at: share only this answer (with its question).
      const { n, at } = (await req.json()) as { n: number; at?: number };
      const chat = await stored(chats, share[1]!, n);
      if (!chat) return new Response("Not found", { status: 404 });
      const one = typeof at === "number" && chat.msgs[at]?.role === "model" && chat.msgs[at - 1]?.role === "user";
      const picked = one ? chat.msgs.slice(at - 1, at + 1) : chat.msgs;
      const title = one ? titleOf(chat.msgs[at - 1]!.text) : chat.title;
      const id = newId();
      // Search results stay with the chat; share pages do not show them.
      const created = await shares.put(id, `${user.u}/${share[1]}`, title, picked.map(({ results: _, ...m }) => m));
      return Response.json({ url: `${url.origin}/s/${id}`, id, created });
    }

    const shareItem = path.match(/^\/api\/chats\/(\w+)\/shares\/(\w+)$/);
    if (shareItem && req.method === "DELETE") {
      const gone = await shares.remove(`${user.u}/${shareItem[1]}`, shareItem[2]!);
      ctx.waitUntil(Promise.all(gone.map((id) => caches.default.delete(shareKey(url.origin, id)))));
      return new Response(null, { status: 204 });
    }

    const api = path.match(/^\/api\/chats\/(\w+)$/);
    if (api && req.method === "POST") {
      // Follow-up, or a rerun of the last question: the client sends the history it already has (ending with the
      // question to answer), so no storage read is on the critical path. model is the chat's chosen model.
      // replace: answer again in place of the answer that follows these messages, keeping later turns and the chat's model.
      const body = (await req.json()) as { title: string; msgs: Msg[]; model?: string; cid?: string; replace?: boolean };
      const model = modelKey(body.model);
      const searching = search(env, queryOf(body.msgs));
      const out = stream();
      ctx.waitUntil((async () => {
        const result = await turn(env, body.msgs, searching,
          (t, v) => out.send(t + (typeof v === "string" ? v : JSON.stringify(v)) + "\u0000"), model);
        await out.close();
        // Save the stored history up to this question, plus this turn. A rerun drops the old answer. The client's copy
        // of earlier answers is never written back.
        const n = body.msgs.length;
        const base = await stored(chats, api[1]!, body.replace ? n + 1 : n - 1);
        if (result) await charge(env, user.u, result.meter);
        if (result && base) {
          if (body.replace) await chats.save(api[1]!, base.title, [...base.msgs.slice(0, n), result.msg, ...base.msgs.slice(n + 1)], undefined, body.cid);
          else await chats.save(api[1]!, base.title, [...base.msgs.slice(0, n - 1), body.msgs.at(-1)!, result.msg], model, body.cid);
        }
      })());
      return new Response(out.readable, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (api && req.method === "GET") {
      const chat = await chats.get(api[1]!);
      return chat ? Response.json(chat) : new Response("Not found", { status: 404 });
    }
    if (api && req.method === "DELETE") {
      const [, gone] = await Promise.all([chats.remove(api[1]!), shares.remove(`${user.u}/${api[1]}`)]);
      ctx.waitUntil(Promise.all(gone.map((id) => caches.default.delete(shareKey(url.origin, id)))));
      return new Response(null, { status: 204 });
    }
    return new Response("Not found", { status: 404 });
  },
};
