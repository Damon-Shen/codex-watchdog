function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createRedactor(config) {
  const secrets = (config?.apiKeys ?? [])
    .map((entry) => entry?.value)
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  return (value) => {
    let message = String(value);
    for (const secret of secrets) {
      message = message.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
    }
    return message;
  };
}

function validateRequestUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Plugin HTTP request requires an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Plugin HTTP request requires an absolute HTTP URL");
  }
  return url.href;
}

export function createPluginHost({ config = {}, fetchImpl = fetch, logger = console } = {}) {
  const lifecycle = new AbortController();
  const redact = createRedactor(config);
  let closed = false;
  const safeLogger = Object.fromEntries(["info", "warn", "error"].map((level) => [
    level,
    (message) => logger?.[level]?.(redact(message)),
  ]));

  const request = async ({
    url,
    method = "GET",
    headers,
    body,
    signal,
    timeoutMs = config.requestTimeoutMs,
  } = {}) => {
    const requestUrl = validateRequestUrl(url);
    if (closed) throw new Error("Plugin host is closed");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Plugin HTTP timeout must be a positive number");
    }
    const signals = [lifecycle.signal, AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);

    try {
      const response = await fetchImpl(requestUrl, {
        method,
        headers,
        body,
        signal: AbortSignal.any(signals),
      });
      return {
        status: response.status,
        ok: response.ok,
        headers: response.headers,
        json: () => response.json(),
        text: () => response.text(),
      };
    } catch (error) {
      const message = redact(error?.message ?? error);
      const wrapped = new Error(`Plugin HTTP request failed for ${redact(requestUrl)}: ${message}`);
      safeLogger.warn(wrapped.message);
      throw wrapped;
    }
  };

  return {
    http: { request },
    logger: safeLogger,
    signal: lifecycle.signal,
    close() {
      if (closed) return;
      closed = true;
      lifecycle.abort(new Error("Plugin host is closed"));
    },
  };
}
