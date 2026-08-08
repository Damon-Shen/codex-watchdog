export function readModelStatus(payload, targetModel) {
  if (!payload || !Array.isArray(payload.services)) return null;

  const service = payload.services.find((candidate) => (
    candidate && typeof candidate === 'object' && candidate.model === targetModel
  ));
  const status = service?.last?.ok;
  return typeof status === 'boolean' ? status : null;
}

export class ModelRecoveryProbe {
  #phase = 'idle';
  #cycle = 0;
  #sawFalse = false;
  #previousWasTrue = false;
  #outcome = null;
  #timer = null;
  #started = false;
  #closed = false;
  #waiters = new Set();
  #activeRequests = new Set();

  constructor({
    url,
    targetModel,
    intervalMs = 30_000,
    requestTimeoutMs = 4_000,
    fetchImpl = fetch,
    schedule = setTimeout,
    cancel = clearTimeout,
    logger = console
  } = {}) {
    if (typeof url !== 'string' || url.trim() === '') throw new TypeError('url must be non-empty');
    if (typeof targetModel !== 'string' || targetModel.trim() === '') {
      throw new TypeError('targetModel must be non-empty');
    }
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError('intervalMs must be finite and greater than zero');
    }

    this.url = url;
    this.targetModel = targetModel;
    this.intervalMs = intervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.fetchImpl = fetchImpl;
    this.schedule = schedule;
    this.cancel = cancel;
    this.logger = logger;
  }

  async checkNow(cycle = this.#cycle) {
    if (this.#closed || cycle !== this.#cycle) return null;

    const controller = new AbortController();
    const request = { controller, cycle };
    this.#activeRequests.add(request);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'GET',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.requestTimeoutMs)
        ])
      });
      if (this.#closed || cycle !== this.#cycle) return null;
      if (!response.ok) throw new Error(`HTTP request failed: ${response.status ?? 'unknown status'}`);

      const payload = await response.json();
      if (this.#closed || cycle !== this.#cycle) return null;
      const status = readModelStatus(payload, this.targetModel);
      if (typeof status !== 'boolean') throw new Error('model status is unknown');

      this.#recordSample(status, cycle);
      return status;
    } catch (error) {
      if (this.#closed || cycle !== this.#cycle) return null;
      this.#recordUnknown(cycle);
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.(`Model probe check failed for ${this.targetModel}: ${message}`);
      return null;
    } finally {
      this.#activeRequests.delete(request);
    }
  }

  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
  }

  beginRecoveryCheck() {
    if (this.#closed) return;
    if (!this.#started) this.start();
    this.#cycle += 1;
    this.#phase = 'confirming';
    this.#sawFalse = false;
    this.#previousWasTrue = false;
    this.#outcome = null;
    if (this.#timer !== null) {
      this.cancel(this.#timer);
      this.#timer = null;
    }
    for (const request of this.#activeRequests) request.controller.abort();
    void this.#poll(this.#cycle);
  }

  waitForRecovery() {
    if (this.#closed) return Promise.reject(new Error('Model recovery probe is closed'));
    if (this.#phase === 'ready') return Promise.resolve(this.#outcome);
    return new Promise((resolve, reject) => {
      this.#waiters.add({ resolve, reject });
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const request of this.#activeRequests) request.controller.abort();
    this.#activeRequests.clear();
    if (this.#timer !== null) {
      this.cancel(this.#timer);
      this.#timer = null;
    }
    const error = new Error('Model recovery probe is closed');
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  async #poll(cycle) {
    if (this.#closed || cycle !== this.#cycle || this.#phase !== 'confirming') return;
    await this.checkNow(cycle);
    if (this.#closed || cycle !== this.#cycle || this.#phase !== 'confirming') return;
    this.#timer = this.schedule(() => {
      this.#timer = null;
      void this.#poll(cycle);
    }, this.intervalMs);
  }

  #recordSample(status, cycle) {
    if (this.#closed || cycle !== this.#cycle || this.#phase !== 'confirming') return;
    if (status === false) {
      this.#sawFalse = true;
      this.#previousWasTrue = false;
      return;
    }
    if (this.#sawFalse) return this.#markReady('recovered-after-false');
    if (this.#previousWasTrue) return this.#markReady('confirmed-healthy');
    this.#previousWasTrue = true;
  }

  #recordUnknown(cycle) {
    if (this.#closed || cycle !== this.#cycle || this.#phase !== 'confirming') return;
    if (!this.#sawFalse) this.#previousWasTrue = false;
  }

  #markReady(outcome) {
    this.#phase = 'ready';
    this.#outcome = outcome;
    for (const waiter of this.#waiters) waiter.resolve(outcome);
    this.#waiters.clear();
  }
}
