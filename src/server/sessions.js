// @ts-check
/** Bounded LRU map: conversation fingerprint -> claude session id. */
export class SessionStore {
  /** @param {number} [max] */
  constructor(max = 1000) { this.max = max; /** @type {Map<string,string>} */ this.map = new Map(); }
  /** @param {string} fp */
  get(fp) {
    const v = this.map.get(fp);
    if (v !== undefined) { this.map.delete(fp); this.map.set(fp, v); }
    return v;
  }
  /** @param {string} fp @param {string} sessionId */
  set(fp, sessionId) {
    this.map.delete(fp);
    this.map.set(fp, sessionId);
    if (this.map.size > this.max) this.map.delete(/** @type {string} */ (this.map.keys().next().value));
  }
  /** @param {string} fp */
  delete(fp) { this.map.delete(fp); }
}
