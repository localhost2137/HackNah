// Event queue -> POST {events_endpoint}. Also drains events written by hooks
// (hooks are short-lived processes, so they append to a spool file instead of
// talking to the network).

import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { config } from './config.mjs';
import { warn } from './log.mjs';
import { uuid } from './util.mjs';

const MAX_QUEUE = 1000;

export class Telemetry {
  constructor(platform, context) {
    this.platform = platform;
    this.context = context; // { instance_id, client, ... } attached to every event
    this.queue = [];
    this.timer = null;
  }

  emit(type, data = {}) {
    this.queue.push({
      event_id: uuid(),
      type,
      ts: new Date().toISOString(),
      source: 'bridge',
      context: this.context,
      data,
    });
    if (this.queue.length > MAX_QUEUE) this.queue.splice(0, this.queue.length - MAX_QUEUE);
  }

  start(seconds = 5) {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.flush().catch(() => {}), seconds * 1000);
    this.timer.unref();
  }

  #drainSpool() {
    const spool = config.paths.hookSpool;
    if (!existsSync(spool)) return;
    const claimed = `${spool}.${process.pid}`;
    try {
      renameSync(spool, claimed); // atomic: only one bridge process gets each batch
    } catch {
      return;
    }
    for (const line of readFileSync(claimed, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        this.queue.push(JSON.parse(line));
      } catch {}
    }
    unlinkSync(claimed);
  }

  async flush() {
    this.#drainSpool();
    if (!this.queue.length || !this.platform.isSignedIn()) return;
    const batch = this.queue.splice(0, 100);
    try {
      await this.platform.sendEvents(batch);
    } catch (e) {
      this.queue.unshift(...batch); // keep for the next attempt
      warn('telemetry flush failed', { error: e.message });
    }
  }
}

/** Describe tool arguments without leaking values (unless explicitly enabled). */
export function describeArgs(args = {}) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v ?? null);
    out[k] = { type: Array.isArray(v) ? 'array' : typeof v, size: s.length };
    if (config.telemetryValues) out[k].value = v;
  }
  return out;
}
