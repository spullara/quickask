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
    from: { name: "QuickAsk", email: env.SENDER },
    to,
    subject,
    text: `${intro}\n\n${url}\n\n${outro}\n\n--\nQuickAsk, fast answers from the web. ${site}`,
    html: `<div style="font:15px/1.5 -apple-system,system-ui,sans-serif;color:#111;max-width:480px">
<p>${esc(intro)}</p>
<p style="margin:20px 0"><a href="${esc(url)}" style="background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;font-weight:600;display:inline-block">${esc(button)}</a></p>
<p style="color:#666;font-size:13px">${esc(outro)}</p>
<p style="color:#999;font-size:12px;border-top:1px solid #eee;padding-top:12px;margin-top:24px">QuickAsk, fast answers from the web. <a href="${esc(site)}" style="color:#999">${esc(host)}</a></p></div>`,
  });
  // Shows in Workers logs; the same message is in Compute → Email Service → Activity log.
  console.log(JSON.stringify({ email: "sent", subject, messageId }));
}

/** Public waitlist routes, or null. */
export async function waitlistRoute(req: Request, env: WorkerEnv, url: URL): Promise<Response | null> {
  if (url.pathname === "/auth/waitlist" && req.method === "POST") {
    const email = emailOf(((await req.json().catch(() => ({}))) as { email?: string }).email);
    if (!email) return json({ error: "Enter a valid email address." });
    const status = await store(env).statusOf(email);
    if (status === "joined") return json({ error: "That email address already has an account. Sign in with your passkey." });
    const ip = req.headers.get("cf-connecting-ip") ?? "";
    if (!(await env.EMAIL_LIMIT.limit({ key: ip }).catch(() => ({ success: true }))).success) return json({ error: "Too many emails. Wait a minute." });
    const { url: href, hash } = await link(env, url.origin, email);
    const err = await store(env).setToken(email, hash, DAY);
    if (err) return json({ error: err });
    const test = await testReply(env, req, email, { sent: true, link: href });
    if (test) return test;
    try {
      if (status === "approved") {
        await mail(env, email, "Create your QuickAsk account", "You are approved for QuickAsk. Open this link to create your passkey.",
          "Create account", href, "The link works for 24 hours.");
      } else {
        await mail(env, email, "Confirm your email for QuickAsk", "Open this link to confirm your email address and join the QuickAsk waitlist.",
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
      return new Response(signIn({ waitlist: true, error: "This link has expired. Enter your email address again." }), { status: 400, headers: html });
    }
    // The admin's own address skips the wait, so a new install can make its first account.
    await store(env).join(email, !!env.ADMIN_NAME && email === env.ADMIN_NAME.toLowerCase());
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
  switch (url.pathname) {
    case "/api/admin/approve": {
      if (!(await auth.approve(email))) return json({ error: "Not on the waitlist." }, 404);
      const { url: href, hash } = await link(env, url.origin, email);
      await auth.forceToken(email, hash, 7 * DAY);
      const test = await testReply(env, req, email, { ok: true, link: href });
      if (test) return test;
      try {
        await mail(env, email, "You're in: create your QuickAsk account", "You are off the QuickAsk waitlist. Open this link to create your passkey and start asking.",
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
