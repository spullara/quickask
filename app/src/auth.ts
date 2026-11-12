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
const json = (v: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { headers: { "content-type": "application/json", ...headers } });

async function start(env: WorkerEnv, challenge: string, extra: object = {}) {
  return setCookie("c", await sign(env.SESSION_SECRET, { ch: challenge, e: Date.now() + 300_000, ...extra }), 300);
}

async function finish(env: WorkerEnv, userId: string, name: string) {
  const s = await sign(env.SESSION_SECRET, { u: userId, n: name, e: Date.now() + 365 * DAY * 1000 } satisfies Session);
  return { "set-cookie": setCookie("s", s, 365 * DAY) };
}

/** Routes under /auth/, or null. Loaded with a dynamic import so the WebAuthn library stays off the search path. */
export async function authRoute(req: Request, env: WorkerEnv, url: URL): Promise<Response | null> {
  const rpID = url.hostname, origin = url.origin;
  const store = env.AUTH.get(env.AUTH.idFromName("auth"));

  switch (url.pathname) {
    case "/auth/register/options": {
      const { name } = (await req.json()) as { name: string };
      const userName = name.trim().slice(0, 60);
      if (!userName) return json({ error: "Enter a name." });
      const userId = isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(16)));
      const options = await generateRegistrationOptions({
        rpName: "Quick", rpID, userName, userID: isoBase64URL.toBuffer(userId), attestationType: "none",
        authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
      });
      return json(options, { "set-cookie": await start(env, options.challenge, { u: userId, n: userName }) });
    }
    case "/auth/register/verify": {
      const pending = await unsign<{ ch: string; u: string; n: string; e: number }>(env.SESSION_SECRET, cookie(req, "c"));
      if (!pending) return json({ error: "Sign-up expired. Try again." });
      const { verified, registrationInfo: info } = await verifyRegistrationResponse({
        response: (await req.json()) as RegistrationResponseJSON, expectedChallenge: pending.ch, expectedOrigin: origin, expectedRPID: rpID,
      });
      if (!verified) return json({ error: "Passkey not verified." });
      await store.addUser(pending.u, pending.n, {
        id: info.credential.id,
        publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
        counter: info.credential.counter,
        transports: JSON.stringify(info.credential.transports ?? []),
      });
      return json({ ok: true }, await finish(env, pending.u, pending.n));
    }
    case "/auth/login/options": {
      const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
      return json(options, { "set-cookie": await start(env, options.challenge) });
    }
    case "/auth/login/verify": {
      const pending = await unsign<{ ch: string; e: number }>(env.SESSION_SECRET, cookie(req, "c"));
      if (!pending) return json({ error: "Sign-in expired. Try again." });
      const response = await req.json() as Parameters<typeof verifyAuthenticationResponse>[0]["response"];
      const cred = await store.getCred(response.id);
      if (!cred) return json({ error: "This passkey is not registered here." });
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response, expectedChallenge: pending.ch, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: cred.id, publicKey: isoBase64URL.toBuffer(cred.publicKey), counter: cred.counter, transports: JSON.parse(cred.transports) },
      });
      if (!verified) return json({ error: "Passkey not verified." });
      await store.setCounter(cred.id, authenticationInfo.newCounter);
      return json({ ok: true }, await finish(env, cred.userId, cred.name));
    }
    case "/auth/logout":
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": setCookie("s", "", 0) } });
  }
  return null;
}
