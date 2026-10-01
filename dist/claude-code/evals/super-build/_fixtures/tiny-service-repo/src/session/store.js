'use strict';

class SessionStore {
  constructor({ now = Date.now } = {}) {
    this.records = new Map();
    this.locks = new Map();
    this.seq = 0;
    this.now = now;
  }

  create(fields) {
    const id = `s${++this.seq}`;
    const record = { id, ...fields, version: 1 };
    this.records.set(id, record);
    return { ...record };
  }

  get(id) {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  withLock(id, fn) {
    const previous = this.locks.get(id) || Promise.resolve();
    const run = previous.then(fn, fn);
    this.locks.set(id, run.catch(() => {}));
    return run;
  }

  // Extends a session and rotates its token. loadToken may be slow (it calls
  // the identity provider), so concurrent refreshes of one session are common.
  async refresh(id, extendSeconds, loadToken) {
    return this.withLock(id, async () => {
      const current = this.get(id);
      if (!current) return null;
      const token = await loadToken(current);
      const updated = { ...current, token, expiresAt: this.now() + extendSeconds * 1000, version: current.version + 1 };
      this.records.set(id, updated);
      return { ...updated };
    });
  }
}

module.exports = { SessionStore };
