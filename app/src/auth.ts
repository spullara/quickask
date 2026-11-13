import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { WorkerEnv } from "../alchemy.run.ts";
import { cookie, setCookie, sign, unsign, type Session } from "./session.ts";

const DAY = 86400;
/** JSON reply. Several Set-Cookie headers are allowed (session plus remaining ceremonies). */
const json = (v: unknown, cookies: string[] = [], status = 200) => {
  const headers = new Headers({ "content-type": "application/json" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(v), { status, headers });
};

/**
 * Pending passkey ceremonies, kept in the signed "c" cookie. The last three are kept, so a second tap, a second tab or a
 * retried request does not overwrite the challenge an authenticator is still signing.
 */
type Pending = { ch: string; e: number; u?: string; n?: string };
const KEEP = 3, TTL = 300_000;

async function pendingOf(env: WorkerEnv, req: Request): Promise<Pending[]> {
  const c = await unsign<{ p?: Pending[]; e: number }>(env.SESSION_SECRET, cookie(req, "c"));
  const now = Date.now();
  return (c?.p ?? []).filter((x) => x.e > now);
}

async function ceremonies(env: WorkerEnv, list: Pending[]) {
  if (!list.length) return setCookie("c", "", 0);
  return setCookie("c", await sign(env.SESSION_SECRET, { p: list, e: Math.max(...list.map((x) => x.e)) }), TTL / 1000);
}

async function start(env: WorkerEnv, req: Request, challenge: string, extra: Partial<Pending> = {}) {
  return ceremonies(env, [{ ch: challenge, e: Date.now() + TTL, ...extra }, ...(await pendingOf(env, req))].slice(0, KEEP));
}

/** The pending ceremony whose challenge the authenticator actually signed, read from its own client data. */
async function signedFor(env: WorkerEnv, req: Request, body: { response?: { clientDataJSON?: string } }) {
  const list = await pendingOf(env, req);
  let ch: string | undefined;
  try {
    ch = JSON.parse(isoBase64URL.toUTF8String(body.response?.clientDataJSON ?? "")).challenge;
  } catch {}
  const entry = list.find((x) => x.ch === ch);
  return { entry, rest: list.filter((x) => x !== entry) };
}

const hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const codeHash = (env: WorkerEnv, email: string, code: string) => hex(`${email}:${code.replace(/\D/g, "")}:${env.SESSION_SECRET}`);

/** Accounts are named by email address. Returns the normalized address, or null. */
const emailOf = (v: unknown) => {
  const e = String(v ?? "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

async function sendCode(env: WorkerEnv, req: Request, email: string) {
  if (!env.EMAIL) return json({ skip: true });
  const ip = req.headers.get("cf-connecting-ip") ?? "";
  if (!(await env.EMAIL_LIMIT.limit({ key: ip }).catch(() => ({ success: true }))).success) return json({ error: "Too many codes. Wait a minute." });
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
  const store = env.AUTH.get(env.AUTH.idFromName("auth"));
  const err = await store.setCode(email, await codeHash(env, email, code));
  if (err) return json({ error: err });
  // The end-to-end test signs up @example.com addresses, which get no mail. It proves it knows the session secret.
  if (email.endsWith("@example.com") && req.headers.get("x-e2e") === (await hex(`${env.SESSION_SECRET}:e2e`))) return json({ sent: true, code });
  const host = new URL(req.url).hostname;
  try {
    await env.EMAIL.send({
    from: { name: "QuickAsk", email: env.SENDER },
    to: email,
    subject: `${code} is your QuickAsk code`,
    text: `Your QuickAsk sign-up code is ${code}\n\nIt expires in 10 minutes. If you did not try to sign up at ${host}, ignore this email.`,
    html: `<div style="font:15px/1.5 -apple-system,system-ui,sans-serif;color:#111">
<p>Your QuickAsk sign-up code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px;margin:8px 0">${code}</p>
<p style="color:#666">It expires in 10 minutes. If you did not try to sign up at ${host}, ignore this email.</p></div>`,
    });
  } catch (e) {
    return json({ error: `Could not send the email: ${(e as Error).message}` });
  }
  return json({ sent: true });
}

async function finish(env: WorkerEnv, userId: string, name: string) {
  return setCookie("s", await sign(env.SESSION_SECRET, { u: userId, n: name, e: Date.now() + 365 * DAY * 1000 } satisfies Session), 365 * DAY);
}

/** Routes under /auth/, or null. Loaded with a dynamic import so the WebAuthn library stays off the search path. */
export async function authRoute(req: Request, env: WorkerEnv, url: URL): Promise<Response | null> {
  try {
    return await route(req, env, url);
  } catch (e) {
    // The sign-in page reads every reply as JSON, so failures must be JSON too, never an HTML 500.
    return json({ error: `Passkey check failed: ${(e as Error).message}` }, [], 400);
  }
}

async function route(req: Request, env: WorkerEnv, url: URL): Promise<Response | null> {
  const rpID = url.hostname, origin = url.origin;
  const store = env.AUTH.get(env.AUTH.idFromName("auth"));

  switch (url.pathname) {
    case "/auth/register/code": {
      const email = emailOf(((await req.json()) as { name?: string }).name);
      if (!email) return json({ error: "Enter a valid email address." });
      if (await store.nameTaken(email)) return json({ error: "That email address already has an account." });
      return sendCode(env, req, email);
    }
    case "/auth/register/options": {
      const { name, code } = (await req.json()) as { name: string; code?: string };
      const userName = emailOf(name);
      if (!userName) return json({ error: "Enter a valid email address." });
      if (await store.nameTaken(userName)) return json({ error: "That email address already has an account." });
      // With email sending on, the address must be confirmed with the emailed code before a passkey is made.
      if (env.EMAIL) {
        const err = await store.checkCode(userName, await codeHash(env, userName, String(code ?? "")));
        if (err) return json({ error: err });
      }
      const userId = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)));
      const options = await generateRegistrationOptions({
        rpName: "Quick", rpID, userName, userID: isoBase64URL.toBuffer(userId), attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      return json(options, [await start(env, req, options.challenge, { u: userId, n: userName })]);
    }
    case "/auth/register/verify": {
      const body = (await req.json()) as RegistrationResponseJSON;
      const { entry, rest } = await signedFor(env, req, body);
      if (!entry?.u || !entry.n) return json({ error: "Sign-up expired. Try again." });
      const { verified, registrationInfo: info } = await verifyRegistrationResponse({
        response: body, expectedChallenge: entry.ch, expectedOrigin: origin, expectedRPID: rpID,
      });
      if (!verified) return json({ error: "Passkey not verified." });
      await store.addUser(entry.u, entry.n, {
        id: info.credential.id,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: JSON.stringify(info.credential.transports ?? []),
      }, !!env.EMAIL);
      return json({ ok: true }, [await finish(env, entry.u, entry.n), await ceremonies(env, rest)]);
    }
    case "/auth/login/options": {
      const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
      return json(options, [await start(env, req, options.challenge)]);
    }
    case "/auth/login/verify": {
      const response = (await req.json()) as Parameters<typeof verifyAuthenticationResponse>[0]["response"];
      const { entry, rest } = await signedFor(env, req, response);
      if (!entry) return json({ error: "Sign-in expired. Try again." });
      const cred = await store.getCred(response.id);
      if (!cred) return json({ error: "This passkey is not registered here." });
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response, expectedChallenge: entry.ch, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: cred.id, publicKey: isoBase64URL.toBuffer(cred.publicKey), counter: cred.counter, transports: JSON.parse(cred.transports) },
      });
      if (!verified) return json({ error: "Passkey not verified." });
      await store.setCounter(cred.id, authenticationInfo.newCounter);
      return json({ ok: true }, [await finish(env, cred.userId, cred.name), await ceremonies(env, rest)]);
    }
    case "/auth/logout":
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": setCookie("s", "", 0) } });
  }
  return null;
}
