import assert from "node:assert/strict";
import test from "node:test";

import { classifyRecoveryRequestError, classifyTerminalError } from "../src/policy.mjs";

function errorNotification({
  info,
  message = "provider error",
  additionalDetails = null,
  willRetry = false,
}) {
  return {
    method: "error",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry,
      error: {
        message,
        codexErrorInfo: info,
        additionalDetails,
      },
    },
  };
}

test("classifies structured provider 503 as transient", () => {
  const result = classifyTerminalError(
    errorNotification({ info: { httpConnectionFailed: { httpStatusCode: 503 } } }),
  );

  assert.deepEqual(result, {
    transient: true,
    reason: "http-503",
    statusCode: 503,
  });
});

test("preserves structured HTTP 503 classification for model-at-capacity messages", () => {
  const result = classifyTerminalError(
    errorNotification({
      info: { httpConnectionFailed: { httpStatusCode: 503 } },
      message: "Selected model is at capacity. Please try a different model.",
    }),
  );

  assert.deepEqual(result, {
    transient: true,
    reason: "http-503",
    statusCode: 503,
  });
});

test("classifies structured model-at-capacity errors for immediate recovery", () => {
  const result = classifyTerminalError(
    errorNotification({
      info: "serverOverloaded",
      message: "Selected model is at capacity. Please try a different model.",
      willRetry: true,
    }),
  );

  assert.deepEqual(result, {
    transient: true,
    reason: "model-at-capacity",
    statusCode: null,
    willRetry: true,
    recoveryMode: "immediate",
  });
});

test("classifies unstructured model-at-capacity errors for immediate recovery", () => {
  const result = classifyTerminalError(
    errorNotification({
      info: "other",
      message: "Selected model is at capacity. Please try a different model.",
    }),
  );

  assert.deepEqual(result, {
    transient: true,
    reason: "model-at-capacity",
    statusCode: null,
    recoveryMode: "immediate",
  });
});

test("classifies non-capacity server overloads without immediate recovery", () => {
  const result = classifyTerminalError(
    errorNotification({
      info: "serverOverloaded",
      message: "provider overloaded",
    }),
  );

  assert.deepEqual(result, {
    transient: true,
    reason: "server-overloaded",
    statusCode: null,
  });
});

test("classifies provider 429 after retry exhaustion as transient", () => {
  const notifications = [
    errorNotification({
      info: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      message: "exceeded retry limit, last status: 429 Too Many Requests",
    }),
    errorNotification({
      info: "other",
      message: "exceeded retry limit, last status: 429 Too Many Requests, request id: test-request",
    }),
  ];

  for (const notification of notifications) {
    assert.deepEqual(classifyTerminalError(notification), {
      transient: true,
      reason: "http-429",
      statusCode: 429,
    });
  }
});

test("does not retry structured 429 when the provider reports exhausted quota", () => {
  const notifications = [
    errorNotification({
      info: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      message: "429 insufficient_quota: quota exhausted",
    }),
    errorNotification({
      info: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      additionalDetails: "insufficient_quota: quota exhausted",
    }),
  ];

  for (const notification of notifications) {
    assert.deepEqual(classifyTerminalError(notification), {
      transient: false,
      reason: "permanent-error-message",
      statusCode: null,
    });
  }
});

test("classifies exhausted stream connection failures without a status as transient", () => {
  const result = classifyTerminalError(
    errorNotification({
      info: { responseTooManyFailedAttempts: { httpStatusCode: null } },
    }),
  );

  assert.equal(result.transient, true);
  assert.equal(result.reason, "response-too-many-failed-attempts");
});

test("marks structured transient errors while Codex is still retrying", () => {
  const result = classifyTerminalError(
    errorNotification({
      info: { httpConnectionFailed: { httpStatusCode: 503 } },
      willRetry: true,
    }),
  );

  assert.deepEqual(result, {
    transient: true,
    reason: "http-503",
    statusCode: 503,
    willRetry: true,
  });
});

test("does not resume permanent, quota, or failed compaction requests", () => {
  const cases = [
    errorNotification({ info: "unauthorized", message: "401 unauthorized" }),
    errorNotification({ info: "usageLimitExceeded", message: "usage limit" }),
    errorNotification({ info: "other", message: "429 insufficient_quota: quota exhausted" }),
    errorNotification({ info: "badRequest", message: "400 bad request" }),
    errorNotification({ info: "other", message: "remote compaction failed" }),
  ];

  for (const notification of cases) {
    assert.equal(classifyTerminalError(notification).transient, false);
  }
});

test("classifies context-window exhaustion for compact-then-resume recovery", () => {
  assert.deepEqual(classifyTerminalError(errorNotification({
    info: "contextWindowExceeded",
    message: "Codex ran out of room in the model's context window.",
  })), {
    transient: false,
    reason: "context-window-exhausted",
    statusCode: null,
    recoveryAction: "compact",
  });
});

test("retries only transient compact request failures", () => {
  const unavailable = new Error("503 Service Unavailable");
  unavailable.code = 503;
  assert.deepEqual(classifyRecoveryRequestError(unavailable), {
    retry: true,
    reason: "transient-recovery-request",
  });

  const unauthorized = new Error("unauthorized");
  unauthorized.code = 401;
  assert.deepEqual(classifyRecoveryRequestError(unauthorized), {
    retry: false,
    reason: "authentication-failed",
  });
  assert.deepEqual(classifyRecoveryRequestError(new Error("invalid request")), {
    retry: false,
    reason: "permanent-recovery-request",
  });
});

test("uses a narrow message fallback for unstructured gateway failures", () => {
  const result = classifyTerminalError(
    errorNotification({ info: "other", message: "upstream returned 503 Service Unavailable" }),
  );

  assert.equal(result.transient, true);
  assert.equal(result.statusCode, 503);
});
