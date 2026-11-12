/** Stateless signed cookies. Kept free of heavy imports: this runs on every request. */
import type { WorkerEnv } from "../alchemy.run.ts";

export type Session = { u: string; n: string; e: number };

const enc = new TextEncoder();
export const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

let hmac: Promise<CryptoKey> | undefined;
const key = (secret: string) =>
  (hmac ??= crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));

export async function sign(secret: string, value: object) {
  const body = b64u(enc.encode(JSON.stringify(value)));
  const mac = await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body));
  return `${body}.${b64u(new Uint8Array(mac))}`;
}

export async function unsign<T extends { e: number }>(secret: string, token: string | undefined): Promise<T | null> {
  const [body, mac] = token?.split(".") ?? [];
  if (!body || !mac) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await key(secret), unb64u(mac), enc.encode(body));
    const value = ok ? (JSON.parse(new TextDecoder().decode(unb64u(body))) as T) : null;
    return value && value.e > Date.now() ? value : null;
  } catch {
    return null;
  }
}

export const cookie = (req: Request, name: string) =>
  req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1];

export const setCookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;

/** Pure HMAC check, no storage read, so it adds well under a millisecond to every request. */
export const session = (req: Request, env: WorkerEnv) => unsign<Session>(env.SESSION_SECRET, cookie(req, "s"));
