/** Waitlist: join by email link, admin approval, per-user daily limits. Loaded on demand, never on the search path. */
import type { WorkerEnv } from "../alchemy.run.ts";
import { b64u, cookie, setCookie, sign, unsign } from "./session.ts";
import { signIn } from "./page.ts";

const HOUR = 3600_000, DAY = 24 * HOUR;

export const hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Accounts are named by email address. Returns the normalized address, or null. */
export const emailOf = (v: unknown) => {
  const e = String(v ?? "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

/** The address this browser proved it owns by opening an email link (the signed "w" cookie). */
export async function confirmed(env: WorkerEnv, req: Request) {
  const v = await unsign<{ w?: string; e: number }>(env.SESSION_SECRET, cookie(req, "w"));
  return typeof v?.w === "string" ? v.w : null;
}

/** The end-to-end test proves it knows the session secret, and then gets email links in replies instead of mail. */
export const isE2E = async (env: WorkerEnv, req: Request) => req.headers.get("x-e2e") === (await hex(`${env.SESSION_SECRET}:e2e`));

/** Reserved test domains (RFC 2606) never get mail. */
const TEST_ADDRESS = /@(?:[^@]+\.)?(?:example\.(?:com|net|org)|[^@]*\.(?:test|invalid|example|localhost))$/;

/**
 * Tests never send email: test addresses, and any request that carries the test header (right or wrong), get the link
 * in the reply when the test proved the secret, or an error otherwise.
 */
async function testReply(env: WorkerEnv, req: Request, email: string, ok: object) {
  if (!TEST_ADDRESS.test(email) && !req.headers.has("x-e2e")) return null;
  return (await isE2E(env, req)) ? json(ok) : json({ error: "This address cannot get email." });
}

const store = (env: WorkerEnv) => env.AUTH.get(env.AUTH.idFromName("auth"));

/**
 * Test accounts and sign-ups: reserved test domains, plus accounts from before names were email addresses
 * ("e2e-alice", "Sam (demo)"). The admin page hides them or rolls them into one row.
 */
export const isTest = (name: string) => TEST_ADDRESS.test(name) || /^e2e-/i.test(name) || /\(demo\)$/i.test(name);

/** Tell the admin's open pages that the waitlist or the users changed, so /admin refreshes itself. */
export async function notifyAdmin(env: WorkerEnv) {
  try {
    const id = env.ADMIN_NAME ? await store(env).firstNamed(env.ADMIN_NAME) : null;
    if (id) await env.CHATS.get(env.CHATS.idFromName(id)).broadcast({ admin: Date.now() });
  } catch {}
}
const json = (v: unknown, status = 200) => Response.json(v, { status });
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A new email link for an address. The token is stored hashed. */
async function link(env: WorkerEnv, origin: string, email: string) {
  const token = b64u(crypto.getRandomValues(new Uint8Array(24)));
  return { url: `${origin}/auth/confirm?e=${encodeURIComponent(email)}&t=${token}`, hash: await hex(`${email}:${token}:${env.SESSION_SECRET}`) };
}

async function mail(env: WorkerEnv, to: string, subject: string, intro: string, button: string, url: string, outro: string) {
  const site = new URL(url).origin, host = new URL(url).host;
  if (TEST_ADDRESS.test(to)) throw new Error("test address");
  const { messageId } = await env.EMAIL!.send({
    from: { name: "Quisk", email: env.SENDER },
    to,
    subject,
    text: `${intro}\n\n${url}\n\n${outro}\n\n--\nQuisk, fast answers from the web. ${site}`,
    html: `<div style="font:15px/1.5 -apple-system,system-ui,sans-serif;color:#111;max-width:480px">
<p>${esc(intro)}</p>
<p style="margin:20px 0"><a href="${esc(url)}" style="background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600;display:inline-block">${esc(button)}</a></p>
<p style="color:#666;font-size:13px">${esc(outro)}</p>
<p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:12px;margin-top:24px">Quisk, fast answers from the web. <a href="${esc(site)}" style="color:#999">${esc(host)}</a></p></div>`,
  });
  // Shows in Workers logs; the same message is in Compute → Email Service → Activity log.
  console.log(JSON.stringify({ email: "sent", subject, messageId }));
}

/**
 * Sign this browser in and go to a page. Arrivals from an email link or from the old domain have no passkey for this
 * domain yet, so the app offers to add one (the "pk" cookie) until the person adds one or says no.
 */
export async function arrive(env: WorkerEnv, req: Request, user: { u: string; n: string }, to: string) {
  const headers = new Headers({ location: to.startsWith("/") && !to.startsWith("//") ? to : "/" });
  headers.append("set-cookie", setCookie("s", await sign(env.SESSION_SECRET, { ...user, e: Date.now() + 365 * DAY }), 365 * 86400));
  if (cookie(req, "pk") !== "done") headers.append("set-cookie", setCookie("pk", "1", 30 * 86400));
  return new Response(null, { status: 302, headers });
}

/** Hand a signed-in person from an old domain to the new one, keeping the page and query. Valid for one minute. */
export async function moveLink(env: WorkerEnv, user: { u: string; n: string }, to: string) {
  const t = await sign(env.SESSION_SECRET, { mv: { u: user.u, n: user.n }, to, e: Date.now() + 60_000 });
  return `https://${env.APP_DOMAIN}/auth/move?t=${encodeURIComponent(t)}`;
}

/** The new domain's end of a move. */
export async function moveIn(env: WorkerEnv, req: Request, url: URL) {
  const v = await unsign<{ mv?: { u: string; n: string }; to?: string; e: number }>(env.SESSION_SECRET, url.searchParams.get("t") ?? "");
  if (!v?.mv || typeof v.mv.u !== "string") return Response.redirect(`${url.origin}/`, 302);
  return arrive(env, req, v.mv, v.to ?? "/");
}

/** Public waitlist routes, or null. */
export async function waitlistRoute(req: Request, env: WorkerEnv, url: URL): Promise<Response | null> {
  if (url.pathname === "/auth/waitlist" && req.method === "POST") {
    const email = emailOf(((await req.json().catch(() => ({}))) as { email?: string }).email);
    if (!email) return json({ error: "Enter a valid email address." });
    const status = await store(env).statusOf(email);
    const ip = req.headers.get("cf-connecting-ip") ?? "";
    if (!(await env.EMAIL_LIMIT.limit({ key: ip }).catch(() => ({ success: true }))).success) return json({ error: "Too many emails. Wait a minute." });
    const { url: href, hash } = await link(env, url.origin, email);
    // An address with an account gets a sign-in link instead (a lost passkey, or a new domain after a move).
    const err = await store(env).setToken(email, hash, status === "joined" ? 15 * 60_000 : DAY);
    if (err) return json({ error: err });
    const test = await testReply(env, req, email, { sent: true, link: href });
    if (test) return test;
    try {
      if (status === "joined") {
        await mail(env, email, "Sign in to Quisk", "Open this link to sign in to Quisk. You can then add a passkey for this device.",
          "Sign in", href, `The link works for 15 minutes. If you did not ask to sign in at ${url.host}, ignore this email.`);
      } else if (status === "approved") {
        await mail(env, email, "Create your Quisk account", "You are approved for Quisk. Open this link to create your passkey.",
          "Create account", href, "The link works for 24 hours.");
      } else {
        await mail(env, email, "Confirm your email for Quisk", "Open this link to confirm your email address and join the Quisk waitlist.",
          "Join the waitlist", href, `The link works for 24 hours. If you did not ask to join at ${url.host}, ignore this email.`);
      }
    } catch (e) {
      return json({ error: `Could not send the email: ${(e as Error).message}` });
    }
    return json({ sent: true });
  }

  if (url.pathname === "/auth/confirm") {
    const email = emailOf(url.searchParams.get("e"));
    const token = url.searchParams.get("t") ?? "";
    const html = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (!email || !(await store(env).checkToken(email, await hex(`${email}:${token}:${env.SESSION_SECRET}`)))) {
      return new Response(signIn({ waitlist: true, error: "This link has expired or was already used. Enter your email address to get a new one." }), { status: 400, headers: html });
    }
    // An account's own address: the link signs in.
    if ((await store(env).statusOf(email)) === "joined") {
      const id = await store(env).firstNamed(email);
      if (id) return arrive(env, req, { u: id, n: email }, "/");
    }
    // The admin's own address skips the wait, so a new install can make its first account.
    await store(env).join(email, !!env.ADMIN_NAME && email === env.ADMIN_NAME.toLowerCase());
    if (!isTest(email)) await notifyAdmin(env);
    const w = await sign(env.SESSION_SECRET, { w: email, e: Date.now() + 30 * DAY });
    return new Response(null, { status: 302, headers: { location: "/", "set-cookie": setCookie("w", w, 30 * 86400) } });
  }
  return null;
}

/** Admin actions on /api/admin/*. The caller checked that this is the admin. */
export async function adminRoute(req: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { email?: string; daily?: number | null };
  const email = emailOf(body.email);
  if (!email || req.method !== "POST") return json({ error: "Bad request" }, 400);
  const auth = store(env);
  if (!isTest(email)) await notifyAdmin(env);
  switch (url.pathname) {
    case "/api/admin/approve": {
      if (!(await auth.approve(email))) return json({ error: "Not on the waitlist." }, 404);
      const { url: href, hash } = await link(env, url.origin, email);
      await auth.forceToken(email, hash, 7 * DAY);
      const test = await testReply(env, req, email, { ok: true, link: href });
      if (test) return test;
      try {
        await mail(env, email, "You're in: create your Quisk account", "You are off the Quisk waitlist. Open this link to create your passkey and start asking.",
          "Create account", href, "The link works for 7 days.");
      } catch (e) {
        return json({ ok: true, error: `Approved, but the email failed: ${(e as Error).message}` });
      }
      return json({ ok: true });
    }
    case "/api/admin/remove":
      await auth.unlist(email);
      return json({ ok: true });
    case "/api/admin/limit": {
      const daily = body.daily === null ? null : Math.max(0, Math.min(100_000, Math.round(Number(body.daily))));
      if (daily !== null && !Number.isFinite(daily)) return json({ error: "Bad limit" }, 400);
      const id = await auth.setDaily(email, daily);
      if (!id) return json({ error: "No such user." }, 404);
      await env.CHATS.get(env.CHATS.idFromName(id)).setDaily(daily);
      return json({ ok: true, daily });
    }
  }
  return json({ error: "Not found" }, 404);
}
