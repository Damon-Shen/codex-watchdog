export function readModelStatus(payload, targetModel) {
  if (!payload || !Array.isArray(payload.services)) return null;

  const service = payload.services.find((candidate) => (
    candidate && typeof candidate === 'object' && candidate.model === targetModel
  ));
  const status = service?.last?.ok;
  return typeof status === 'boolean' ? status : null;
}

export class ModelRecoveryProbe {
  #state = 'unknown';
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

  async checkNow() {
    if (this.#closed) return null;

    const controller = new AbortController();
    this.#activeRequests.add(controller);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'GET',
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(this.requestTimeoutMs)
        ])
      });
      if (this.#closed) return null;
      if (!response.ok) throw new Error(`HTTP request failed: ${response.status ?? 'unknown status'}`);

      const payload = await response.json();
      if (this.#closed) return null;
      const status = readModelStatus(payload, this.targetModel);
      if (typeof status !== 'boolean') throw new Error('model status is unknown');

      this.#recordSample(status);
      return status;
    } catch (error) {
      if (this.#closed) return null;
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn?.(`Model probe check failed for ${this.targetModel}: ${message}`);
      return null;
    } finally {
      this.#activeRequests.delete(controller);
    }
  }

  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    void this.#poll();
  }

  waitForRecovery() {
    if (this.#closed) return Promise.reject(new Error('Model recovery probe is closed'));
    if (this.#state === 'recovered') return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.#waiters.add({ resolve, reject });
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#activeRequests) controller.abort();
    this.#activeRequests.clear();
    if (this.#timer !== null) {
      this.cancel(this.#timer);
      this.#timer = null;
    }
    const error = new Error('Model recovery probe is closed');
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  async #poll() {
    await this.checkNow();
    if (this.#closed) return;
    this.#timer = this.schedule(() => {
      this.#timer = null;
      void this.#poll();
    }, this.intervalMs);
  }

  #recordSample(status) {
    if (this.#closed) return;
    if (status === false) {
      this.#state = 'down';
      return;
    }
    if (this.#state === 'down') {
      this.#state = 'recovered';
      for (const waiter of this.#waiters) waiter.resolve();
      this.#waiters.clear();
      return;
    }
    if (this.#state === 'unknown') this.#state = 'healthy-unarmed';
  }
}
