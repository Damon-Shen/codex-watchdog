import { randomUUID } from "node:crypto";

const ID_PREFIX = "goal-watchdog:";

export class RpcChannel {
  constructor({ send, timeoutMs = 10_000 }) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.idPrefix = `${ID_PREFIX}${randomUUID()}:`;
    this.nextId = 1;
    this.pending = new Map();
  }

  request(method, params) {
    const id = `${this.idPrefix}${this.nextId++}`;
    const message = JSON.stringify({ method, id, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });

      try {
        this.send(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  consume(message) {
    const id = message?.id;
    if (typeof id !== "string" || !id.startsWith(this.idPrefix)) return false;

    const pending = this.pending.get(id);
    if (!pending) return true;
    clearTimeout(pending.timeout);
    this.pending.delete(id);

    if (message.error) {
      const error = new Error(
        message.error.message || `${pending.method} failed with an unknown error`,
      );
      if (message.error.code !== undefined) error.code = message.error.code;
      if (message.error.data !== undefined) error.data = message.error.data;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
    return true;
  }

  close(reason = "RPC channel closed") {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
