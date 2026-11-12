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

