import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";

type Cred = { id: string; userId: string; name: string; publicKey: string; counter: number; transports: string };

/** Users and their passkeys. One global instance; only touched during sign-in. */
export class Auth extends DurableObject<WorkerEnv> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS creds (id TEXT PRIMARY KEY, user_id TEXT, public_key TEXT, counter INTEGER, transports TEXT);
      CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, hash TEXT, expires INTEGER, tries INTEGER, sent INTEGER, sends TEXT)`);
    // 1 when the email address was confirmed with a code. Accounts made before codes existed stay NULL.
    if (!this.sql.exec("SELECT 1 FROM pragma_table_info('users') WHERE name = 'verified'").toArray().length) {
      this.sql.exec("ALTER TABLE users ADD COLUMN verified INTEGER");
    }
  }

  /**
   * Store a new sign-up code for an email address (hashed). Limits: one send each 30 s and five each hour per address.
   * Returns an error message, or null when the code may be sent.
   */
  setCode(email: string, hash: string): string | null {
    const now = Date.now();
    const row = this.sql.exec<{ sent: number; sends: string }>("SELECT sent, sends FROM codes WHERE email = ?", email).toArray()[0];
    const sends = (JSON.parse(row?.sends ?? "[]") as number[]).filter((t) => t > now - 3600_000);
    if (row && now - row.sent < 30_000) return "A code was just sent. Wait 30 seconds to send another.";
    if (sends.length >= 5) return "Too many codes for this address. Try again in an hour.";
    sends.push(now);
    this.sql.exec("INSERT OR REPLACE INTO codes VALUES (?, ?, ?, 0, ?, ?)", email, hash, now + 600_000, now, JSON.stringify(sends));
    return null;
  }

  /** Check a code. Five wrong tries end it. The code stays valid until the account is made, so a cancelled passkey can retry. */
  checkCode(email: string, hash: string): string | null {
    const row = this.sql.exec<{ hash: string; expires: number; tries: number }>("SELECT hash, expires, tries FROM codes WHERE email = ?", email).toArray()[0];
    if (!row || row.expires < Date.now() || row.tries >= 5) return "That code expired. Send a new one.";
    if (row.hash === hash) return null;
    this.sql.exec("UPDATE codes SET tries = tries + 1 WHERE email = ?", email);
    return "Wrong code. Check the email and try again.";
  }

  addUser(userId: string, name: string, cred: { id: string; publicKey: string; counter: number; transports: string }, verified: boolean) {
    this.sql.exec("INSERT INTO users (id, name, created, verified) VALUES (?, ?, ?, ?)", userId, name, Date.now(), verified ? 1 : null);
    // The code is spent. The send history stays, so the hourly limit still counts.
    this.sql.exec("UPDATE codes SET expires = 0 WHERE email = ?", name);
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

