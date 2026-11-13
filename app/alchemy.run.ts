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
/** Earlier domains (comma separated). They serve the Worker only to move people, their passkeys' sign-in and links to DOMAIN. */
const OLD = (process.env.OLD_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
/**
 * Waitlist emails come from this address. Only with a custom domain on Cloudflare DNS (Email Service needs the zone),
 * and not when WAITLIST=off. Without it, the app uses the shared access key and open passkey sign-up instead.
 */
export const SENDER = DOMAIN && ZONE && process.env.WAITLIST !== "off" ? `login@${DOMAIN}` : undefined;
const Sending = SENDER ? Cloudflare.Email.SendingSubdomain("Sending", { zoneId: ZONE!, name: DOMAIN! }) : undefined;
/**
 * A sending domain that can also receive mail looks legitimate to spam filters: Email Routing gives it MX and SPF records,
 * and every address at the domain (login@, support@, dmarc@ ...) forwards to MAIL_FORWARD_TO. DMARC reports show how
 * receivers judge the mail.
 */
const FORWARD = process.env.MAIL_FORWARD_TO;
const Inbound = SENDER && FORWARD ? [
  Cloudflare.Email.Routing("Routing", { zone: ZONE! }),
  Cloudflare.Email.Address("ForwardTo", { email: FORWARD }),
  Cloudflare.Email.CatchAll("CatchAll", { zone: ZONE!, actions: [{ type: "forward", value: [FORWARD] }] }),
] : [];
/** Delivery results (delivered, deferred, bounced, ...) of the emails sent from DOMAIN, consumed by the Worker. */
const EmailEvents = SENDER ? Cloudflare.Queues.Queue("EmailEvents", {}) : undefined;
const EMAIL_EVENTS = ["message.delivered", "message.deferred", "message.bounced", "message.failed", "message.rejected", "message.complained"];
const Dmarc = SENDER ? Cloudflare.Email.DmarcReports("Dmarc", { zone: ZONE! }) : undefined;

export const Worker = Cloudflare.Worker("Quick", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-11-01" },
  observability: { enabled: true },
  build: { output: { minify: true } },
  // Passkeys bind to this hostname. Set QUICK_DOMAIN in app/.env once the domain is in this Cloudflare account.
  ...(DOMAIN ? { domain: OLD.length ? { name: DOMAIN, aliases: OLD } : DOMAIN } : {}),
  env: {
    CARD: CardWorker,
    CHATS: Cloudflare.DurableObject<Chats>("Chats", { className: "Chats" }),
    AUTH: Cloudflare.DurableObject<Auth>("Auth", { className: "Auth" }),
    SHARES: Cloudflare.DurableObject<Shares>("Shares", { className: "Shares" }),
    USAGE: Cloudflare.DurableObject<Usage>("Usage", { className: "Usage" }),
    // Exa allows 10 searches a second. Counted in each Cloudflare location, so it needs no long-distance call.
    EXA_LIMIT: Cloudflare.RateLimit("EXA_LIMIT", { namespaceId: 2001, simple: { limit: 100, period: 10 } }),
    // Waitlist emails, at most 5 a minute from one IP address.
    EMAIL_LIMIT: Cloudflare.RateLimit("EMAIL_LIMIT", { namespaceId: 2002, simple: { limit: 5, period: 60 } }),
    ...(SENDER ? { EMAIL: Cloudflare.Email.SendEmail("EMAIL", { allowedSenderAddresses: [SENDER] }) } : {}),
    SENDER: SENDER ?? "",
    APP_DOMAIN: DOMAIN ?? "",
    // MOVE=off keeps old domains serving the app (for example until a new domain's DNS is live).
    OLD_DOMAINS: process.env.MOVE === "off" ? "" : OLD.join(","),
    GEMINI_API_KEY: Config.Redacted("GEMINI_API_KEY"),
    EXA_API_KEY: Config.Redacted("EXA_API_KEY"),
    ACCESS_KEY: Config.Redacted("ACCESS_KEY"),
    SESSION_SECRET: Config.Redacted("SESSION_SECRET"),
    ADMIN_NAME: Config.String("ADMIN_NAME").pipe(Config.withDefault("")),
    // Questions a day for each user (the admin has no limit). The admin can change it per user on /admin.
    DAILY_QUERIES: Config.String("DAILY_QUERIES").pipe(Config.withDefault("100")),
  },
});

export interface WorkerEnv extends Omit<Cloudflare.InferEnv<typeof Worker>, "EMAIL"> {
  /** Absent without a custom domain or with WAITLIST=off: the access key and open sign-up are used instead. */
  EMAIL?: SendEmail;
}

export default Alchemy.Stack(
  "Quick",
  { providers: Cloudflare.providers(), state: State.localState() },
  Effect.gen(function* () {
    if (Sending) yield* Sending;
    for (const r of Inbound) yield* r;
    if (Dmarc) yield* Dmarc;
    yield* CardWorker;
    const worker = yield* Worker;
    if (EmailEvents) {
      const q = yield* EmailEvents;
      yield* Cloudflare.Queues.Consumer("EmailEventsConsumer", { queueId: q.queueId, scriptName: worker.workerName });
      yield* Cloudflare.Queues.Subscription("EmailEventsSub", {
        source: { type: "email.sending", zoneId: ZONE!, domain: DOMAIN! }, events: EMAIL_EVENTS, queueId: q.queueId,
      });
    }
    return { url: worker.url };
  }),
);
