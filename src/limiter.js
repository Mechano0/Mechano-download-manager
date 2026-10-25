'use strict';
// Global speed limiter shared by every connection (IDM: CSpeedLimiter).
// Virtual-clock token bucket: each take(n) reserves n/rate seconds of line time.
const { sleep } = require('./util');

class RateLimiter {
  constructor(bytesPerSecond = 0) {
    this.rate = bytesPerSecond;
    this.clock = 0;
  }

  setRate(bytesPerSecond) {
    this.rate = Math.max(0, Number(bytesPerSecond) || 0);
    this.clock = 0;
  }

  async take(n, signal) {
    if (!this.rate) return;
    const now = Date.now();
    this.clock = Math.max(this.clock, now - 250) + (n / this.rate) * 1000; // allow a 250 ms burst
    const wait = this.clock - now;
    if (wait > 0) await sleep(wait, signal);
  }
}

module.exports = { RateLimiter };
