import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";

/** Gemini 3.5 Flash Lite list prices, USD per token. Thinking tokens bill as output. */
export const GEMINI_IN = 0.3 / 1e6;
export const GEMINI_OUT = 2.5 / 1e6;

/** Exa allows this many searches per second for the whole app. */
const RATE = 10;

export type Meter = { exa: number; tokensIn: number; tokensOut: number };
export type Totals = { searches: number; exa: number; gemini: number; cost: number; tokensIn: number; tokensOut: number };

/** One global instance: the Exa rate limiter and the cost ledger. */
export class Usage extends DurableObject<WorkerEnv> {
  sql = this.ctx.storage.sql;
  tokens = RATE;
  refilled = Date.now();

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usage (day TEXT, user TEXT, searches INTEGER, exa REAL, tokens_in INTEGER,
      tokens_out INTEGER, PRIMARY KEY (day, user))`);
  }

  /**
   * Token bucket: RATE tokens, refilled at RATE per second. A caller always gets a slot;
   * the return value is how many ms to wait for it. Tokens go negative to queue callers in order.
   */
  acquire(): number {
    const now = Date.now();
    this.tokens = Math.min(RATE, this.tokens + ((now - this.refilled) * RATE) / 1000);
    this.refilled = now;
    this.tokens -= 1;
    return this.tokens >= 0 ? 0 : Math.ceil((-this.tokens * 1000) / RATE);
  }

  record(user: string, m: Meter) {
    this.sql.exec(
      `INSERT INTO usage VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT (day, user) DO UPDATE SET searches = searches + 1,
       exa = exa + excluded.exa, tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
      new Date().toISOString().slice(0, 10), user, m.exa, m.tokensIn, m.tokensOut,
    );
  }

  /** Totals since a day (inclusive), grouped by "day", "user" or nothing. */
  totals(since: string, by?: "day" | "user") {
    const key = by ? `${by},` : "";
    return this.sql.exec<{ day?: string; user?: string; searches: number; exa: number; tokens_in: number; tokens_out: number }>(
      `SELECT ${key} SUM(searches) AS searches, SUM(exa) AS exa, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
       FROM usage WHERE day >= ? ${by ? `GROUP BY ${by}` : ""}`, since,
    ).toArray().map(({ tokens_in, tokens_out, ...r }) => {
      const gemini = (tokens_in ?? 0) * GEMINI_IN + (tokens_out ?? 0) * GEMINI_OUT;
      return { ...r, searches: r.searches ?? 0, exa: r.exa ?? 0, gemini, cost: (r.exa ?? 0) + gemini, tokensIn: tokens_in ?? 0, tokensOut: tokens_out ?? 0 };
    }).sort((a, b) => (by === "day" ? (b.day ?? "").localeCompare(a.day ?? "") : b.cost - a.cost));
  }
}
