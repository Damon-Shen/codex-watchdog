function readModelStatus(payload, targetModel) {
  if (!Array.isArray(payload?.services)) return null;
  const service = payload.services.find((candidate) => candidate?.model === targetModel);
  return typeof service?.last?.ok === "boolean" ? service.last.ok : null;
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be finite and greater than zero`);
  }
  return value;
}

export class ModelAvailabilityMonitor {
  #status = null;
  #started = false;
  #closed = false;
  #timer = null;
  #activeController = null;
  #waiters = new Set();
  #snapshot;

  constructor({
    url,
    targetModel,
    intervalMs = 60_000,
    requestTimeoutMs = 5_000,
    fetchImpl = fetch,
    schedule = setTimeout,
    cancel = clearTimeout,
    logger = console,
  } = {}) {
    if (typeof url !== "string" || url.trim() === "") throw new TypeError("url must be non-empty");
    if (typeof targetModel !== "string" || targetModel.trim() === "") {
      throw new TypeError("targetModel must be non-empty");
    }
    this.url = url;
    this.targetModel = targetModel;
    this.intervalMs = positiveNumber(intervalMs, "intervalMs");
    this.requestTimeoutMs = positiveNumber(requestTimeoutMs, "requestTimeoutMs");
    this.fetchImpl = fetchImpl;
    this.schedule = schedule;
    this.cancel = cancel;
    this.logger = logger;
    this.#snapshot = {
      enabled: true,
      state: "unknown",
      model: targetModel,
      url,
      checkedAt: null,
      sourceGeneratedAt: null,
      latencyMs: null,
      error: null,
    };
  }

  get available() {
    return this.#status === true;
  }

  snapshot() {
    return { ...this.#snapshot };
  }

  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    void this.#poll();
  }

  async checkNow() {
    if (this.#closed) return null;
    this.#activeController?.abort();
    const controller = new AbortController();
    this.#activeController = controller;
    try {
      const response = await this.fetchImpl(this.url, {
        method: "GET",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(this.requestTimeoutMs)]),
      });
      if (this.#closed || controller.signal.aborted) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      if (this.#closed || controller.signal.aborted) return null;
      const status = readModelStatus(payload, this.targetModel);
      if (typeof status !== "boolean") throw new Error("model status is unknown");
      const service = payload.services.find(({ model }) => model === this.targetModel);
      this.#record(status, {
        sourceGeneratedAt: Number.isFinite(payload.generated_at) ? payload.generated_at : null,
        latencyMs: Number.isFinite(service?.last?.latency_ms) ? service.last.latency_ms : null,
        error: typeof service?.last?.error === "string" ? service.last.error : null,
      });
      return status;
    } catch (error) {
      if (this.#closed || controller.signal.aborted) return null;
      const message = error instanceof Error ? error.message : String(error);
      this.#record(null, { error: message });
      return null;
    } finally {
      if (this.#activeController === controller) this.#activeController = null;
    }
  }

  waitUntilAvailable({ signal } = {}) {
    if (this.#closed) return Promise.reject(new Error("model availability monitor is closed"));
    if (this.available) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("request aborted"));

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abortHandler: null };
      if (signal) {
        waiter.abortHandler = () => {
          this.#waiters.delete(waiter);
          reject(signal.reason ?? new Error("request aborted"));
        };
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      this.#waiters.add(waiter);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#activeController?.abort();
    this.#activeController = null;
    if (this.#timer !== null) {
      this.cancel(this.#timer);
      this.#timer = null;
    }
    const error = new Error("model availability monitor is closed");
    for (const waiter of this.#waiters) {
      waiter.signal?.removeEventListener("abort", waiter.abortHandler);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }

  async #poll() {
    if (this.#closed) return;
    await this.checkNow();
    if (this.#closed) return;
    const timer = this.schedule(() => {
      if (this.#timer === timer) this.#timer = null;
      void this.#poll();
    }, this.intervalMs);
    this.#timer = timer;
  }

  #record(status, details) {
    this.#status = status;
    const state = status === true ? "online" : status === false ? "offline" : "unknown";
    this.#snapshot = {
      enabled: true,
      state,
      model: this.targetModel,
      url: this.url,
      checkedAt: new Date().toISOString(),
      sourceGeneratedAt: details.sourceGeneratedAt ?? null,
      latencyMs: details.latencyMs ?? null,
      error: details.error ?? null,
    };

    const suffix = details.error ? `; ${details.error}` : "";
    const log = status === true ? this.logger?.info : this.logger?.warn;
    log?.call(this.logger, `Model monitor ${this.targetModel}: ${state}${suffix}`);

    if (status !== true) return;
    for (const waiter of this.#waiters) {
      waiter.signal?.removeEventListener("abort", waiter.abortHandler);
      waiter.resolve();
    }
    this.#waiters.clear();
  }
}
