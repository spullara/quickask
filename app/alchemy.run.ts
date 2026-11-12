import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as State from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { Chats } from "./src/worker.ts";

export const Worker = Cloudflare.Worker("Quick", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-11-01" },
  observability: { enabled: true },
  env: {
    CHATS: Cloudflare.DurableObject<Chats>("Chats", { className: "Chats" }),
    GEMINI_API_KEY: Config.Redacted("GEMINI_API_KEY"),
    ACCESS_KEY: Config.Redacted("ACCESS_KEY"),
  },
});

export interface WorkerEnv extends Cloudflare.InferEnv<typeof Worker> {}

export default Alchemy.Stack(
  "Quick",
  { providers: Cloudflare.providers(), state: State.localState() },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
