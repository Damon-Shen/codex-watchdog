export class ModelRecoveryGate {
  #phase = "idle";
  #cycle = 0;
  #context = {};
  #sawFalse = false;
  #previousWasTrue = false;
  #outcome = null;
  #timer = null;
  #activeRequest = null;
  #closed = false;
  #waiters = new Set();

  constructor({
    checkModel,
    intervalMs,
    schedule = setTimeout,
    cancel = clearTimeout,
    logger = console,
  } = {}) {
    if (typeof checkModel !== "function") throw new Error("checkModel must be a function");
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("intervalMs must be a positive number");
    }
    this.checkModel = checkModel;
    this.intervalMs = intervalMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.logger = logger;
  }

  beginRecoveryCheck(context = {}) {
    if (this.#closed) throw new Error("Model recovery gate is closed");
    this.#cycle += 1;
    this.#phase = "confirming";
    this.#context = context;
    this.#sawFalse = false;
    this.#previousWasTrue = false;
    this.#outcome = null;
    this.#cancelTimer();
    this.#activeRequest?.controller.abort(new Error("Model recovery cycle was superseded"));
    void this.#poll(this.#cycle);
  }

  waitForRecovery() {
    if (this.#closed) return Promise.reject(new Error("Model recovery gate is closed"));
    if (this.#phase === "ready") return Promise.resolve(this.#outcome);
    return new Promise((resolve, reject) => this.#waiters.add({ resolve, reject }));
  }

  cancelRecoveryCheck(reason = new Error("Model recovery cycle was cancelled")) {
    if (this.#closed) return;
    this.#cycle += 1;
    this.#phase = "idle";
    this.#outcome = null;
    this.#cancelTimer();
    this.#activeRequest?.controller.abort(reason);
    this.#activeRequest = null;
    for (const waiter of this.#waiters) waiter.reject(reason);
    this.#waiters.clear();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#phase = "closed";
    this.#cancelTimer();
    this.#activeRequest?.controller.abort(new Error("Model recovery gate is closed"));
    this.#activeRequest = null;
    const error = new Error("Model recovery gate is closed");
    for (const waiter of this.#waiters) waiter.reject(error);
    this.#waiters.clear();
  }

  #cancelTimer() {
    if (this.#timer === null) return;
    this.cancel(this.#timer);
    this.#timer = null;
  }

  async #poll(cycle) {
    if (this.#closed || cycle !== this.#cycle || this.#phase !== "confirming") return;
    const controller = new AbortController();
    const request = { cycle, controller };
    this.#activeRequest = request;
    try {
      const sample = await this.checkModel({ ...this.#context, signal: controller.signal });
      if (this.#closed || cycle !== this.#cycle || this.#phase !== "confirming") return;
      if (typeof sample === "boolean") this.#recordSample(sample);
      else this.#recordUnknown();
    } catch (error) {
      if (this.#closed || cycle !== this.#cycle || this.#phase !== "confirming") return;
      this.#recordUnknown();
      this.logger?.warn?.(`Model recovery check failed: ${error?.message ?? error}`);
    } finally {
      if (this.#activeRequest === request) this.#activeRequest = null;
    }
    if (this.#closed || cycle !== this.#cycle || this.#phase !== "confirming") return;
    const timer = this.schedule(() => {
      if (this.#timer === timer) this.#timer = null;
      void this.#poll(cycle);
    }, this.intervalMs);
    this.#timer = timer;
  }

  #recordSample(sample) {
    if (sample === false) {
      this.#sawFalse = true;
      this.#previousWasTrue = false;
      return;
    }
    if (this.#sawFalse) {
      this.#markReady("recovered-after-false");
      return;
    }
    if (this.#previousWasTrue) {
      this.#markReady("confirmed-healthy");
      return;
    }
    this.#previousWasTrue = true;
  }

  #recordUnknown() {
    if (!this.#sawFalse) this.#previousWasTrue = false;
  }

  #markReady(outcome) {
    this.#phase = "ready";
    this.#outcome = outcome;
    for (const waiter of this.#waiters) waiter.resolve(outcome);
    this.#waiters.clear();
  }
}
