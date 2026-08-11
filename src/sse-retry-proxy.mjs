import { createServer } from "node:http";
import { Readable } from "node:stream";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RECOVERABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const RECOVERABLE_ERROR_PATTERN =
  /(server_overloaded|rate_limit_exceeded|service_unavailable|temporarily_unavailable|upstream_timeout|Selected model is at capacity\. Please try a different model\.|stream disconnected before completion|stream closed before response\.completed|rate limit|service temporarily unavailable|connection reset|timed out|timeout)/i;

const TERMINAL_RESPONSE_EVENTS = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLogger(logger) {
  return {
    info: logger?.info?.bind(logger) ?? (() => {}),
    warn: logger?.warn?.bind(logger) ?? (() => {}),
    error: logger?.error?.bind(logger) ?? (() => {}),
  };
}

function buildUpstreamUrl(upstreamOrigin, requestUrl) {
  const origin = new URL(upstreamOrigin);
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("upstreamOrigin must contain only scheme, host, and optional port");
  }
  return new URL(requestUrl, origin);
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value == null || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("accept-encoding", "identity");
  return headers;
}

function responseHeaders(upstreamResponse) {
  const headers = {};
  for (const [name, value] of upstreamResponse.headers) {
    const normalized = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === "content-encoding") continue;
    headers[name] = value;
  }
  return headers;
}

async function readIncomingBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error(`request body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readBufferedResponse(upstreamResponse, maxBytes) {
  if (!upstreamResponse.body) return { buffer: Buffer.alloc(0), overflow: false };

  const reader = upstreamResponse.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { buffer: Buffer.concat(chunks, total), overflow: false };
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    total += chunk.length;
    if (total > maxBytes) {
      return { chunks, reader, overflow: true };
    }
  }
}

function sseEvents(bodyText) {
  return bodyText
    .split(/\r?\n\r?\n/)
    .map((frame) => {
      let event = "message";
      const data = [];
      for (const line of frame.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      return { event, data: data.join("\n") };
    })
    .filter(({ data }) => data.length > 0 && data !== "[DONE]");
}

function errorEnvelopeText(eventName, payload) {
  const type = String(payload?.type ?? eventName ?? "");
  const failedResponse = payload?.response?.status === "failed" ? payload.response : null;
  const isErrorEvent = /(error|failed)/i.test(type);
  if (!isErrorEvent && !payload?.error && !payload?.response?.error && !failedResponse) {
    return null;
  }
  return JSON.stringify({
    event: eventName,
    type,
    payload: isErrorEvent ? payload : undefined,
    error: payload?.error,
    responseError: payload?.response?.error,
    failedResponse,
  });
}

export function classifyBufferedResponse({ status, contentType, body }) {
  if (RECOVERABLE_HTTP_STATUSES.has(status)) {
    return { retryable: true, reason: `HTTP ${status}` };
  }

  const bodyText = body.toString("utf8");
  if (/text\/event-stream/i.test(contentType ?? "")) {
    const events = sseEvents(bodyText);
    for (const { event, data } of events) {
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      const errorText = errorEnvelopeText(event, payload);
      if (errorText && RECOVERABLE_ERROR_PATTERN.test(errorText)) {
        return { retryable: true, reason: `SSE ${event}` };
      }
    }
    if (!events.some(({ event }) => TERMINAL_RESPONSE_EVENTS.has(event))) {
      return { retryable: true, reason: "SSE stream closed before response.completed" };
    }
    return { retryable: false, reason: null };
  }

  if (/application\/json/i.test(contentType ?? "")) {
    try {
      const payload = JSON.parse(bodyText);
      const errorText = errorEnvelopeText("json", payload);
      if (errorText && RECOVERABLE_ERROR_PATTERN.test(errorText)) {
        return { retryable: true, reason: "JSON error" };
      }
    } catch {
      // Non-JSON bodies are forwarded unchanged.
    }
  }

  return { retryable: false, reason: null };
}

function writeBufferedResponse(response, upstreamResponse, body) {
  const headers = responseHeaders(upstreamResponse);
  headers["content-length"] = String(body.length);
  response.writeHead(upstreamResponse.status, headers);
  response.end(body);
}

async function writeOverflowResponse(response, upstreamResponse, buffered) {
  response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
  for (const chunk of buffered.chunks) response.write(chunk);
  while (true) {
    const { done, value } = await buffered.reader.read();
    if (done) break;
    response.write(Buffer.from(value));
  }
  response.end();
}

function shouldBufferForRetry(request) {
  if (request.method !== "POST") return false;
  const pathname = new URL(request.url, "http://localhost").pathname;
  return pathname.endsWith("/responses");
}

async function forwardUnbuffered(response, upstreamResponse) {
  response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
  if (!upstreamResponse.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const body = Readable.fromWeb(upstreamResponse.body);
    body.once("error", reject);
    response.once("error", reject);
    response.once("finish", resolve);
    body.pipe(response);
  });
}

export async function createSseRetryProxy({
  listenHost = "127.0.0.1",
  listenPort = 3001,
  upstreamOrigin = "http://127.0.0.1:3000",
  retryDelaysMs = [1_000, 3_000, 10_000, 30_000, 60_000],
  maxRequestBytes = 64 * 1024 * 1024,
  maxBufferedResponseBytes = 64 * 1024 * 1024,
  fetchImpl = fetch,
  logger = console,
} = {}) {
  const log = normalizeLogger(logger);
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("retryDelaysMs must contain non-negative millisecond values");
  }

  const server = createServer(async (request, response) => {
    if (request.url === "/healthz" || request.url === "/readyz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok\n");
      return;
    }

    let activeController = null;
    let clientClosed = false;
    const closeHandler = () => {
      if (response.writableEnded) return;
      clientClosed = true;
      activeController?.abort(new Error("desktop client disconnected"));
    };
    request.once("aborted", closeHandler);
    response.once("close", closeHandler);

    try {
      const body = await readIncomingBody(request, maxRequestBytes);
      const upstreamUrl = buildUpstreamUrl(upstreamOrigin, request.url);
      const bufferForRetry = shouldBufferForRetry(request);

      for (let attempt = 0; ; attempt += 1) {
        let upstreamResponse;
        try {
          activeController = new AbortController();
          upstreamResponse = await fetchImpl(upstreamUrl, {
            method: request.method,
            headers: requestHeaders(request),
            body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
            redirect: "manual",
            signal: activeController.signal,
          });
        } catch (error) {
          activeController = null;
          if (clientClosed) return;
          if (attempt >= retryDelaysMs.length || response.destroyed) throw error;
          const waitMs = retryDelaysMs[attempt];
          log.warn(`Upstream request failed (${error.message}); retrying in ${waitMs} ms`);
          await delay(waitMs);
          continue;
        }

        if (!bufferForRetry) {
          await forwardUnbuffered(response, upstreamResponse);
          activeController = null;
          return;
        }

        let buffered;
        try {
          buffered = await readBufferedResponse(upstreamResponse, maxBufferedResponseBytes);
        } catch (error) {
          activeController = null;
          if (clientClosed) return;
          if (attempt >= retryDelaysMs.length || response.destroyed) throw error;
          const waitMs = retryDelaysMs[attempt];
          log.warn(`Upstream response stream failed (${error.message}); retrying in ${waitMs} ms`);
          await delay(waitMs);
          continue;
        }

        if (buffered.overflow) {
          log.warn("Response exceeded the retry buffer; forwarding without automatic replay");
          await writeOverflowResponse(response, upstreamResponse, buffered);
          activeController = null;
          return;
        }
        activeController = null;

        const classification = classifyBufferedResponse({
          status: upstreamResponse.status,
          contentType: upstreamResponse.headers.get("content-type"),
          body: buffered.buffer,
        });
        if (!classification.retryable || attempt >= retryDelaysMs.length) {
          writeBufferedResponse(response, upstreamResponse, buffered.buffer);
          return;
        }

        const waitMs = retryDelaysMs[attempt];
        log.warn(`${classification.reason}; retrying original Responses request in ${waitMs} ms`);
        await delay(waitMs);
        if (clientClosed) return;
      }
    } catch (error) {
      if (clientClosed) return;
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const statusCode = error.statusCode ?? 502;
      log.error(`Desktop proxy request failed: ${error.message}`);
      response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: { message: error.message, type: "desktop_proxy_error" } }));
    } finally {
      activeController?.abort(new Error("desktop proxy request finished"));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, resolve);
  });

  const address = server.address();
  const url = `http://${listenHost}:${address.port}`;
  log.info(`Desktop SSE retry proxy listening on ${url}; upstream ${upstreamOrigin}`);
  return {
    server,
    url,
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
