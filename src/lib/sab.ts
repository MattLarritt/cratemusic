/**
 * SABnzbd, talked to directly.
 *
 * Two things this buys over letting Lidarr own the download: crate learns the
 * percentage while it is happening, so a request can say "downloading, 43%"
 * instead of a silent "queued"; and crate learns about a failure itself rather
 * than inferring one from an absence.
 *
 * SAB's API is query-string based and answers 200 with `{"status": false}` on
 * logical failure, so every call has to check the body rather than the code.
 */

import type { Settings } from './settings.js';

export interface SabJob {
  nzoId: string;
  name: string;
  /** 'queued' | 'downloading' | 'verifying' | 'repairing' | 'extracting' | 'done' | 'failed' */
  state: 'queued' | 'downloading' | 'postprocessing' | 'done' | 'failed' | 'unknown';
  percent: number;
  /** Where the finished files are, as SAB sees the path. Only set once done. */
  path: string | null;
  message: string | null;
  /**
   * SAB's own status string, lowercased.
   *
   * Kept because the mapped `state` cannot distinguish a job waiting its turn in a
   * busy queue from one wedged in a state that will never advance. SAB reported
   * 'Grabbing' forever for an unreachable NZB URL, and treating that as progress
   * left the request queued indefinitely.
   */
  raw: string;
}

interface QueueSlot {
  nzo_id?: string;
  filename?: string;
  status?: string;
  percentage?: string;
  timeleft?: string;
}

interface HistorySlot {
  nzo_id?: string;
  name?: string;
  status?: string;
  storage?: string;
  fail_message?: string;
}

export class Sab {
  /** Config read per call, so an admin edit applies without a container recreate. */
  constructor(private settings: Settings) {}

  get configured(): boolean {
    const c = this.settings.all();
    return Boolean(c.sabUrl && c.sabKey);
  }

  private async call<T>(params: Record<string, string>): Promise<T> {
    const { sabUrl, sabKey } = this.settings.all();
    if (!sabUrl || !sabKey) throw new Error('sabnzbd is not configured');
    const qs = new URLSearchParams({ ...params, output: 'json', apikey: sabKey });
    const res = await fetch(`${sabUrl}/api?${qs.toString()}`);
    if (!res.ok) throw new Error(`sabnzbd ${res.status} on ${params.mode}`);
    return (await res.json()) as T;
  }

  /**
   * Queue an NZB by URL and return SAB's job id.
   *
   * nzbname is set so the completed folder is named after the album rather than
   * whatever the indexer called the post, which is what makes the import step's
   * job obvious and the download folder readable.
   */
  async add(nzbUrl: string, name: string): Promise<string> {
    const body = await this.call<{ status?: boolean; nzo_ids?: string[]; error?: string }>({
      mode: 'addurl',
      name: nzbUrl,
      nzbname: name,
      cat: this.settings.all().sabCategory,
      priority: '0',
    });
    const id = body.nzo_ids?.[0];
    if (!body.status || !id) throw new Error(`sabnzbd refused the nzb: ${body.error ?? 'no id'}`);
    return id;
  }

  /**
   * Where a job is up to.
   *
   * Checks the queue first and history second, because a job that has just
   * finished appears in both for a moment and the queue's copy is the stale one.
   */
  async status(nzoId: string): Promise<SabJob | null> {
    const hist = await this.call<{ history?: { slots?: HistorySlot[] } }>({
      mode: 'history',
      limit: '200',
    });
    const h = hist.history?.slots?.find((s) => s.nzo_id === nzoId);
    if (h) {
      const st = (h.status ?? '').toLowerCase();
      if (st === 'completed') {
        return {
          nzoId,
          name: h.name ?? '',
          state: 'done',
          percent: 100,
          path: h.storage ?? null,
          message: null,
          raw: st,
        };
      }
      if (st === 'failed') {
        return {
          nzoId,
          name: h.name ?? '',
          state: 'failed',
          percent: 0,
          path: null,
          message: h.fail_message || 'download failed',
          raw: st,
        };
      }
      // Extracting, verifying, repairing — still working, just not in the queue.
      return {
        nzoId,
        name: h.name ?? '',
        state: 'postprocessing',
        percent: 99,
        path: null,
        message: h.status ?? null,
        raw: st,
      };
    }

    const q = await this.call<{ queue?: { slots?: QueueSlot[] } }>({ mode: 'queue', limit: '200' });
    const slot = q.queue?.slots?.find((s) => s.nzo_id === nzoId);
    if (!slot) return null;

    const st = (slot.status ?? '').toLowerCase();
    return {
      nzoId,
      name: slot.filename ?? '',
      state: st === 'downloading' ? 'downloading' : st === 'queued' ? 'queued' : 'postprocessing',
      percent: Number(slot.percentage ?? '0') || 0,
      path: null,
      message: slot.timeleft && slot.timeleft !== '0:00:00' ? `${slot.timeleft} left` : null,
      raw: st,
    };
  }

  /** Version and queue depth, for the admin page's connection test. */
  async serverStatus(): Promise<{ version: string; queued: number }> {
    const body = await this.call<{
      queue?: { version?: string; slots?: unknown[] };
    }>({ mode: 'queue', limit: '1' });
    return {
      version: body.queue?.version ?? 'unknown',
      queued: body.queue?.slots?.length ?? 0,
    };
  }

  /** Drop a finished job from history. Never deletes files. */
  async forget(nzoId: string): Promise<void> {
    await this.call({ mode: 'history', name: 'delete', value: nzoId, del_files: '0' });
  }
}
