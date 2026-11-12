import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";

type Cred = { id: string; userId: string; name: string; publicKey: string; counter: number; transports: string };

/** Users and their passkeys. One global instance; only touched during sign-in. */
export class Auth extends DurableObject<WorkerEnv> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS creds (id TEXT PRIMARY KEY, user_id TEXT, public_key TEXT, counter INTEGER, transports TEXT)`);
  }

  addUser(userId: string, name: string, cred: { id: string; publicKey: string; counter: number; transports: string }) {
    this.sql.exec("INSERT INTO users VALUES (?, ?, ?)", userId, name, Date.now());
    this.sql.exec("INSERT INTO creds VALUES (?, ?, ?, ?, ?)", cred.id, userId, cred.publicKey, cred.counter, cred.transports);
  }

  nameTaken(name: string) {
    return this.sql.exec("SELECT 1 FROM users WHERE lower(name) = lower(?) LIMIT 1", name).toArray().length > 0;
  }

  firstNamed(name: string): string | null {
    return this.sql.exec<{ id: string }>("SELECT id FROM users WHERE lower(name) = lower(?) ORDER BY created LIMIT 1", name).toArray()[0]?.id ?? null;
  }

  names(): Record<string, string> {
    return Object.fromEntries(this.sql.exec<{ id: string; name: string }>("SELECT id, name FROM users").toArray().map((r) => [r.id, r.name]));
  }

  getCred(id: string): Cred | null {
    return this.sql.exec<Cred>(
      `SELECT c.id, c.user_id AS userId, u.name, c.public_key AS publicKey, c.counter, c.transports
       FROM creds c JOIN users u ON u.id = c.user_id WHERE c.id = ?`, id,
    ).toArray()[0] ?? null;
  }

  setCounter(id: string, counter: number) {
    this.sql.exec("UPDATE creds SET counter = ? WHERE id = ?", counter, id);
  }
}

