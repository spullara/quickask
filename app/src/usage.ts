import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";

/** The answer model, with list prices in USD per token (thinking tokens bill as output). */
export const MODELS = {
  lite: { id: "gemini-3.5-flash-lite", thinking: "minimal", name: "Gemini 3.5 Flash Lite", in: 0.3 / 1e6, out: 2.5 / 1e6 },
} as const;
export type ModelKey = keyof typeof MODELS;
/** Older chats may name a model that is gone; every answer now uses Flash Lite. */
export const modelKey = (_m?: unknown): ModelKey => "lite";

const LITE_IN = MODELS.lite.in, LITE_OUT = MODELS.lite.out;

export type Meter = { exa: number; tokensIn: number; tokensOut: number; gemini: number };
export type Totals = { searches: number; exa: number; gemini: number; cost: number; tokensIn: number; tokensOut: number };

/** One global instance: the cost ledger. Written after each answer, so it is never on the search path. */
export class Usage extends DurableObject<WorkerEnv> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usage (day TEXT, user TEXT, searches INTEGER, exa REAL, tokens_in INTEGER,
      tokens_out INTEGER, PRIMARY KEY (day, user))`);
    // Gemini cost in USD, added when more than one model existed. Older rows priced their tokens at Flash Lite.
    if (!this.sql.exec("SELECT 1 FROM pragma_table_info('usage') WHERE name = 'gemini'").toArray().length) {
      this.sql.exec("ALTER TABLE usage ADD COLUMN gemini REAL");
    }
  }

  record(user: string, m: Meter) {
    this.sql.exec(
      `INSERT INTO usage (day, user, searches, exa, tokens_in, tokens_out, gemini) VALUES (?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (day, user) DO UPDATE SET searches = searches + 1, exa = exa + excluded.exa,
       gemini = COALESCE(gemini, tokens_in * ${LITE_IN} + tokens_out * ${LITE_OUT}) + excluded.gemini,
       tokens_in = tokens_in + excluded.tokens_in, tokens_out = tokens_out + excluded.tokens_out`,
      new Date().toISOString().slice(0, 10), user, m.exa, m.tokensIn, m.tokensOut, m.gemini,
    );
    return this.totals(new Date().toISOString().slice(0, 8) + "01")[0]!;
  }

  /** Totals since a day (inclusive), grouped by "day", "user" or nothing. */
  totals(since: string, by?: "day" | "user") {
    const key = by ? `${by},` : "";
    return this.sql.exec<{ day?: string; user?: string; searches: number; exa: number; tokens_in: number; tokens_out: number; gemini: number }>(
      `SELECT ${key} SUM(searches) AS searches, SUM(exa) AS exa, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out,
       SUM(COALESCE(gemini, tokens_in * ${LITE_IN} + tokens_out * ${LITE_OUT})) AS gemini
       FROM usage WHERE day >= ? ${by ? `GROUP BY ${by}` : ""}`, since,
    ).toArray().map(({ tokens_in, tokens_out, gemini: g, ...r }) => {
      const gemini = g ?? 0;
      return { ...r, searches: r.searches ?? 0, exa: r.exa ?? 0, gemini, cost: (r.exa ?? 0) + gemini, tokensIn: tokens_in ?? 0, tokensOut: tokens_out ?? 0 };
    }).sort((a, b) => (by === "day" ? (b.day ?? "").localeCompare(a.day ?? "") : b.cost - a.cost));
  }
}
