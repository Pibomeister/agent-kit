'use strict';

// Process-wide cache of organisation records, keyed by organisation id.
// Entries expire after ttlMs; past maxEntries the oldest entry is evicted.
// clear() moves to a new generation, so stale entries are dropped as they
// are read rather than by walking the map.
class OrgCache {
  constructor({ ttlMs = 60000, maxEntries = 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
    this.generation = crypto.randomUUID();
  }

  get(orgId) {
    const entry = this.entries.get(orgId);
    if (!entry) return undefined;
    if (entry.generation !== this.generation || this.now() >= entry.expiresAt) {
      this.entries.delete(orgId);
      return undefined;
    }
    return entry.org;
  }

  set(orgId, org) {
    this.entries.delete(orgId);
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(orgId, { org, expiresAt: this.now() + this.ttlMs, generation: this.generation });
  }

  clear() {
    this.generation = crypto.randomUUID();
  }
}

const shared = new OrgCache();

module.exports = { OrgCache, shared };
