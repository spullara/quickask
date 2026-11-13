import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as State from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { Auth } from "./src/auth-store.ts";
import type { Chats, Shares } from "./src/worker.ts";
import type { Usage } from "./src/usage.ts";

/** Share-card renderer. No public URL: only the main Worker reaches it, through the CARD binding. */
export const CardWorker = Cloudflare.Worker("QuickCard", {
  main: "./src/card.ts",
  compatibility: { date: "2026-11-01" },
  workersDev: false,
  rules: [{ globs: ["**/*.wasm"], type: "CompiledWasm" }, { globs: ["**/*.woff"], type: "Data" }],
});

const DOMAIN = process.env.QUICK_DOMAIN, ZONE = process.env.QUICK_ZONE_ID;
/**
 * Sign-up codes come from this address. Only with a custom domain on Cloudflare DNS (Email Service needs the zone),
 * and not when EMAIL_CODES=off.
 */
export const SENDER = DOMAIN && ZONE && process.env.EMAIL_CODES !== "off" ? `login@${DOMAIN}` : undefined;
const Sending = SENDER ? Cloudflare.Email.SendingSubdomain("Sending", { zoneId: ZONE!, name: DOMAIN! }) : undefined;

export const Worker = Cloudflare.Worker("Quick", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-11-01" },
  observability: { enabled: true },
  build: { output: { minify: true } },
  // Passkeys bind to this hostname. Set QUICK_DOMAIN in app/.env once the domain is in this Cloudflare account.
  ...(DOMAIN ? { domain: DOMAIN } : {}),
  env: {
    CARD: CardWorker,
    CHATS: Cloudflare.DurableObject<Chats>("Chats", { className: "Chats" }),
    AUTH: Cloudflare.DurableObject<Auth>("Auth", { className: "Auth" }),
    SHARES: Cloudflare.DurableObject<Shares>("Shares", { className: "Shares" }),
    USAGE: Cloudflare.DurableObject<Usage>("Usage", { className: "Usage" }),
    // Exa allows 10 searches a second. Counted in each Cloudflare location, so it needs no long-distance call.
    EXA_LIMIT: Cloudflare.RateLimit("EXA_LIMIT", { namespaceId: 2001, simple: { limit: 100, period: 10 } }),
    // Sign-up codes, at most 5 a minute from one IP address.
    EMAIL_LIMIT: Cloudflare.RateLimit("EMAIL_LIMIT", { namespaceId: 2002, simple: { limit: 5, period: 60 } }),
    ...(SENDER ? { EMAIL: Cloudflare.Email.SendEmail("EMAIL", { allowedSenderAddresses: [SENDER] }) } : {}),
    SENDER: SENDER ?? "",
    GEMINI_API_KEY: Config.Redacted("GEMINI_API_KEY"),
    EXA_API_KEY: Config.Redacted("EXA_API_KEY"),
    ACCESS_KEY: Config.Redacted("ACCESS_KEY"),
    SESSION_SECRET: Config.Redacted("SESSION_SECRET"),
    ADMIN_NAME: Config.String("ADMIN_NAME").pipe(Config.withDefault("")),
  },
});

export interface WorkerEnv extends Omit<Cloudflare.InferEnv<typeof Worker>, "EMAIL"> {
  /** Absent without a custom domain: sign-up then needs no email code. */
  EMAIL?: SendEmail;
}

export default Alchemy.Stack(
  "Quick",
  { providers: Cloudflare.providers(), state: State.localState() },
  Effect.gen(function* () {
    if (Sending) yield* Sending;
    yield* CardWorker;
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
