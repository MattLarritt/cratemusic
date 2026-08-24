/**
 * Outbound notifications: Pushover and plain REST.
 *
 * Every event carries both a human sentence and a structured payload. Pushover needs
 * the sentence and a REST consumer needs the fields, and generating one from the
 * other at the destination means either a templating language in the admin form or a
 * consumer that has to parse prose. Sending both costs a few bytes.
 *
 * Delivery is deliberately fire-and-forget from the caller's point of view. A
 * notification is a side effect of doing the work, never a condition of it: a
 * Pushover outage must not fail an import, and a REST endpoint that hangs must not
 * hold up the pipeline poll. Failures are recorded against the webhook row so the
 * admin page can show a destination that has quietly stopped working — the same
 * class of silence this codebase has spent a lot of effort removing.
 */

import type Database from 'better-sqlite3';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The events a webhook can subscribe to.
 *
 * Named subject.verb so they group and sort sensibly, and kept few enough to fit on
 * one screen of checkboxes. Adding one means adding an emit() call somewhere; nothing
 * here is inferred.
 */
export const EVENTS = [
  'request.created',
  'download.grabbed',
  'download.retrying',
  'request.fulfilled',
  'request.failed',
  'library.scanned',
  'library.deleted',
  'library.uploaded',
  'user.created',
  'settings.changed',
  'system.started',
] as const;

export type EventName = (typeof EVENTS)[number];

/** Human-readable labels for the admin page, so it does not show raw event ids. */
export const EVENT_LABELS: Record<EventName, string> = {
  'request.created': 'New request',
  'download.grabbed': 'Download started',
  'download.retrying': 'Retrying another release',
  'request.fulfilled': 'Download complete',
  'request.failed': 'Request failed',
  'library.scanned': 'Library scan finished',
  'library.deleted': 'Album or track deleted',
  'library.uploaded': 'Album uploaded by a user',
  'user.created': 'User added',
  'settings.changed': 'Settings changed',
  'system.started': 'crate started',
};

/** An in-process subscriber. Called synchronously at emit; a throw is logged and contained. */
export type EventListener = (
  event: EventName,
  e: { title: string; message: string; data?: Record<string, unknown> },
) => void;

export interface WebhookRow {
  id: number;
  name: string;
  kind: 'pushover' | 'rest';
  enabled: number;
  config: string;
  events: string;
  created_at: number;
  last_at: number | null;
  last_ok: number | null;
  last_error: string | null;
  failures: number;
}

interface PushoverConfig {
  token?: string;
  user?: string;
  /** -2 quiet … 2 emergency. Pushover's own scale. */
  priority?: number;
  device?: string;
  sound?: string;
}

interface RestConfig {
  url?: string;
  method?: string;
  /** Extra request headers, typically an Authorization line. */
  headers?: Record<string, string>;
}

/** Config fields that must never be sent to a browser. */
const SECRET_FIELDS = new Set(['token', 'user', 'headers']);

/** How long a destination gets before it is treated as failed. */
const TIMEOUT_MS = 10_000;

export class Notifier {
  constructor(
    private db: Database.Database,
    private log: FastifyBaseLogger,
  ) {}

  list(): WebhookRow[] {
    return this.db.prepare('SELECT * FROM webhooks ORDER BY id').all() as WebhookRow[];
  }

  get(id: number): WebhookRow | null {
    return (this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow) ?? null;
  }

  create(w: {
    name: string;
    kind: 'pushover' | 'rest';
    enabled: boolean;
    config: Record<string, unknown>;
    events: string[];
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO webhooks (name, kind, enabled, config, events, created_at)
         VALUES (?,?,?,?,?,unixepoch())`,
      )
      .run(w.name, w.kind, w.enabled ? 1 : 0, JSON.stringify(w.config), w.events.join(','));
    return Number(info.lastInsertRowid);
  }

  /**
   * Update, merging config rather than replacing it.
   *
   * Merging is what lets the form omit a secret it was never shown: a saved webhook
   * keeps its Pushover token when somebody edits its name. Same reasoning as the
   * blank-means-keep rule for settings.
   */
  update(
    id: number,
    w: {
      name?: string;
      enabled?: boolean;
      config?: Record<string, unknown>;
      events?: string[];
    },
  ): void {
    const row = this.get(id);
    if (!row) throw new Error('no such webhook');

    const existing = safeParse(row.config);
    const merged = { ...existing };
    for (const [k, v] of Object.entries(w.config ?? {})) {
      // An omitted or blank secret keeps the stored one; everything else is replaced.
      if (SECRET_FIELDS.has(k) && (v === '' || v === undefined || v === null)) continue;
      merged[k] = v;
    }

    this.db
      .prepare(
        `UPDATE webhooks SET
           name = COALESCE(?, name),
           enabled = COALESCE(?, enabled),
           config = ?,
           events = COALESCE(?, events)
         WHERE id = ?`,
      )
      .run(
        w.name ?? null,
        w.enabled === undefined ? null : w.enabled ? 1 : 0,
        JSON.stringify(merged),
        w.events ? w.events.join(',') : null,
        id,
      );
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  }

  /** List shape for the admin page, with secrets reduced to a set-flag and a hint. */
  redactedList(): unknown[] {
    return this.list().map((r) => {
      const cfg = safeParse(r.config);
      const out: Record<string, unknown> = {
        id: r.id,
        name: r.name,
        kind: r.kind,
        enabled: Boolean(r.enabled),
        events: r.events ? r.events.split(',').filter(Boolean) : [],
        lastAt: r.last_at,
        lastOk: r.last_ok === null ? null : Boolean(r.last_ok),
        lastError: r.last_error,
        failures: r.failures,
        config: {} as Record<string, unknown>,
      };
      const safe = out.config as Record<string, unknown>;
      for (const [k, v] of Object.entries(cfg)) {
        if (SECRET_FIELDS.has(k)) {
          const str = typeof v === 'string' ? v : JSON.stringify(v ?? '');
          safe[`${k}Set`] = Boolean(str && str !== '{}' && str !== '""');
          safe[`${k}Hint`] = str && str.length > 4 ? `…${str.slice(-4)}` : '';
        } else {
          safe[k] = v;
        }
      }
      return out;
    });
  }

  /**
   * In-process listeners, added for plugins (see lib/plugin.ts).
   *
   * Registered against one event name, dispatched synchronously at the top of emit(). The five
   * existing pipeline emit sites became observable the day this landed, with no change at any
   * call site — which is why this lives on the Notifier rather than in a second emitter that
   * would have needed threading into everything that already emits.
   */
  private listeners = new Map<EventName, Set<EventListener>>();

  on(event: EventName, fn: EventListener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
  }

  /**
   * Send an event to every in-process listener and every enabled webhook subscribed to it.
   *
   * Never throws and never awaited by callers that are doing real work. An empty
   * event list on a webhook means "everything", which is the useful default for a
   * single Pushover destination.
   */
  emit(event: EventName, e: { title: string; message: string; data?: Record<string, unknown> }): void {
    /*
     * Local listeners first, each in its own try/catch: a notification is a side effect of
     * doing the work, never a condition of it, and that has to hold for plugin code too — a
     * throwing listener is a warning in the log, not a broken pipeline and not a lost webhook.
     */
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(event, e);
      } catch (err) {
        this.log.warn({ err: String(err), event }, 'event listener threw');
      }
    }

    let rows: WebhookRow[];
    try {
      rows = this.list().filter((r) => {
        if (!r.enabled) return false;
        const subs = r.events ? r.events.split(',').filter(Boolean) : [];
        return subs.length === 0 || subs.includes(event);
      });
    } catch (err) {
      this.log.warn({ err: String(err) }, 'could not read webhooks');
      return;
    }
    if (!rows.length) return;

    const payload = {
      event,
      at: Math.floor(Date.now() / 1000),
      title: e.title,
      message: e.message,
      data: e.data ?? {},
    };

    for (const row of rows) {
      void this.deliver(row, payload).catch(() => {
        // deliver() already records and logs; this is only here so an unexpected
        // throw cannot become an unhandled rejection and take the process down.
      });
    }
  }

  /** One delivery attempt, with the result recorded on the row. */
  async deliver(
    row: WebhookRow,
    payload: { event: string; at: number; title: string; message: string; data: Record<string, unknown> },
  ): Promise<{ ok: boolean; detail: string }> {
    const cfg = safeParse(row.config);
    const ctl = AbortSignal.timeout(TIMEOUT_MS);

    try {
      let res: Response;
      if (row.kind === 'pushover') {
        const c = cfg as PushoverConfig;
        if (!c.token || !c.user) throw new Error('Pushover needs both an API token and a user key');
        const body = new URLSearchParams({
          token: c.token,
          user: c.user,
          title: payload.title,
          message: payload.message,
          priority: String(c.priority ?? 0),
        });
        if (c.device) body.set('device', c.device);
        if (c.sound) body.set('sound', c.sound);
        res = await fetch('https://api.pushover.net/1/messages.json', {
          method: 'POST',
          body,
          signal: ctl,
        });
        if (!res.ok) {
          // Pushover explains itself in the body; the status alone is not useful.
          const text = await res.text().catch(() => '');
          throw new Error(`Pushover ${res.status}: ${text.slice(0, 160)}`);
        }
      } else {
        const c = cfg as RestConfig;
        if (!c.url) throw new Error('no URL configured');
        res = await fetch(c.url, {
          method: (c.method || 'POST').toUpperCase(),
          headers: { 'Content-Type': 'application/json', ...(c.headers ?? {}) },
          body: JSON.stringify(payload),
          signal: ctl,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }

      this.db
        .prepare(
          'UPDATE webhooks SET last_at = unixepoch(), last_ok = 1, last_error = NULL, failures = 0 WHERE id = ?',
        )
        .run(row.id);
      return { ok: true, detail: 'delivered' };
    } catch (err) {
      const detail =
        err instanceof Error
          ? err.name === 'TimeoutError'
            ? `timed out after ${TIMEOUT_MS / 1000}s`
            : err.message
          : String(err);
      this.db
        .prepare(
          'UPDATE webhooks SET last_at = unixepoch(), last_ok = 0, last_error = ?, failures = failures + 1 WHERE id = ?',
        )
        .run(detail, row.id);
      this.log.warn({ webhook: row.name, kind: row.kind, detail }, 'webhook delivery failed');
      return { ok: false, detail };
    }
  }

  /** Send a sample event to one destination, so a config can be proven before it matters. */
  async test(id: number): Promise<{ ok: boolean; detail: string }> {
    const row = this.get(id);
    if (!row) return { ok: false, detail: 'no such webhook' };
    return this.deliver(row, {
      event: 'system.started',
      at: Math.floor(Date.now() / 1000),
      title: 'crate test notification',
      message: `This is a test from crate for "${row.name}". If you can read it, the destination works.`,
      data: { test: true },
    });
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
