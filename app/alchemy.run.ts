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

export const Worker = Cloudflare.Worker("Quick", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-11-01" },
  observability: { enabled: true },
  build: { output: { minify: true } },
  // Passkeys bind to this hostname. Set QUICK_DOMAIN in app/.env once the domain is in this Cloudflare account.
  ...(process.env.QUICK_DOMAIN ? { domain: process.env.QUICK_DOMAIN } : {}),
  env: {
    CARD: CardWorker,
    CHATS: Cloudflare.DurableObject<Chats>("Chats", { className: "Chats" }),
    AUTH: Cloudflare.DurableObject<Auth>("Auth", { className: "Auth" }),
    SHARES: Cloudflare.DurableObject<Shares>("Shares", { className: "Shares" }),
    USAGE: Cloudflare.DurableObject<Usage>("Usage", { className: "Usage" }),
    GEMINI_API_KEY: Config.Redacted("GEMINI_API_KEY"),
    EXA_API_KEY: Config.Redacted("EXA_API_KEY"),
    ACCESS_KEY: Config.Redacted("ACCESS_KEY"),
    SESSION_SECRET: Config.Redacted("SESSION_SECRET"),
    ADMIN_NAME: Config.String("ADMIN_NAME").pipe(Config.withDefault("")),
  },
});

export interface WorkerEnv extends Cloudflare.InferEnv<typeof Worker> {}

export default Alchemy.Stack(
  "Quick",
  { providers: Cloudflare.providers(), state: State.localState() },
  Effect.gen(function* () {
    yield* CardWorker;
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
