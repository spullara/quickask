import { DurableObject } from "cloudflare:workers";
import type { WorkerEnv } from "../alchemy.run.ts";

export type Status = "waiting" | "approved" | "joined";
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
    // Questions a day for this user; NULL means the default (DAILY_QUERIES).
    if (!this.sql.exec("SELECT 1 FROM pragma_table_info('users') WHERE name = 'daily'").toArray().length) {
      this.sql.exec("ALTER TABLE users ADD COLUMN daily INTEGER");
    }
    // Confirmed addresses waiting for an account. Rows are added only after the email link is opened.
    this.sql.exec("CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, status TEXT, created INTEGER, approved INTEGER)");
  }

  /**
   * Store a new email-link token (hashed) for an address. Limits: one send each 30 s and five each hour per address.
   * Returns an error message, or null when the email may be sent.
   */
  setToken(email: string, hash: string, ttl: number): string | null {
    const now = Date.now();
    const row = this.sql.exec<{ sent: number; sends: string }>("SELECT sent, sends FROM codes WHERE email = ?", email).toArray()[0];
    const sends = (JSON.parse(row?.sends ?? "[]") as number[]).filter((t) => t > now - 3600_000);
    if (row && now - row.sent < 30_000) return "An email was just sent. Wait 30 seconds to send another.";
    if (sends.length >= 5) return "Too many emails for this address. Try again in an hour.";
    sends.push(now);
    this.sql.exec("INSERT OR REPLACE INTO codes VALUES (?, ?, ?, 0, ?, ?)", email, hash, now + ttl, now, JSON.stringify(sends));
    return null;
  }

  /** Approval emails skip the per-address limits: only the admin sends them. */
  forceToken(email: string, hash: string, ttl: number) {
    const now = Date.now();
    this.sql.exec(`INSERT INTO codes VALUES (?, ?, ?, 0, ?, '[]') ON CONFLICT (email) DO UPDATE SET hash = excluded.hash,
      expires = excluded.expires, tries = 0`, email, hash, now + ttl, now);
  }

  /** Check an email-link token. Clicking the link again (or a mail scanner opening it first) still works until it expires. */
  checkToken(email: string, hash: string) {
    const row = this.sql.exec<{ hash: string; expires: number }>("SELECT hash, expires FROM codes WHERE email = ?", email).toArray()[0];
    return !!row && row.expires > Date.now() && row.hash === hash;
  }

  /** Put a confirmed address on the waitlist. The admin's address is approved at once. Returns its status. */
  join(email: string, approve: boolean): Status {
    this.sql.exec(`INSERT INTO waitlist (email, status, created) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING`,
      email, approve ? "approved" : "waiting", Date.now());
    if (approve) this.sql.exec("UPDATE waitlist SET status = 'approved', approved = ? WHERE email = ? AND status = 'waiting'", Date.now(), email);
    return this.statusOf(email)!;
  }

  statusOf(email: string): Status | null {
    if (this.nameTaken(email)) return "joined";
    return this.sql.exec<{ status: Status }>("SELECT status FROM waitlist WHERE email = ?", email).toArray()[0]?.status ?? null;
  }

  /** Returns false when the address is not on the waitlist. */
  approve(email: string) {
    return this.sql.exec("UPDATE waitlist SET status = 'approved', approved = ? WHERE email = ?", Date.now(), email).rowsWritten > 0;
  }

  unlist(email: string) {
    this.sql.exec("DELETE FROM waitlist WHERE email = ?", email);
  }

  waitlist() {
    return this.sql.exec<{ email: string; status: Status; created: number; approved: number | null }>(
      "SELECT email, status, created, approved FROM waitlist WHERE status != 'joined' ORDER BY created").toArray();
  }

  users() {
    return this.sql.exec<{ id: string; name: string; created: number; daily: number | null }>(
      "SELECT id, name, created, daily FROM users ORDER BY created").toArray();
  }

  /** The user's own daily limit; null returns them to the default. Returns the user's id, or null when unknown. */
  setDaily(email: string, daily: number | null) {
    const id = this.firstNamed(email);
    if (id) this.sql.exec("UPDATE users SET daily = ? WHERE id = ?", daily, id);
    return id;
  }

  addUser(userId: string, name: string, cred: { id: string; publicKey: string; counter: number; transports: string }, verified: boolean) {
    this.sql.exec("INSERT INTO users (id, name, created, verified) VALUES (?, ?, ?, ?)", userId, name, Date.now(), verified ? 1 : null);
    // The link is spent. The send history stays, so the hourly limit still counts.
    this.sql.exec("UPDATE codes SET expires = 0 WHERE email = ?", name);
    this.sql.exec("UPDATE waitlist SET status = 'joined' WHERE email = ?", name);
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

