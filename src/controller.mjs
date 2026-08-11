import { classifyRecoveryRequestError, classifyTerminalError } from "./policy.mjs";

const STOPPED_GOAL_STATUSES = new Set([
  "paused",
  "usageLimited",
  "budgetLimited",
  "quotaExhausted",
  "authenticationFailed",
  "unauthorized",
  "complete",
]);
const INTERRUPTABLE_GOAL_STATUSES = new Set(["active"]);
const BLOCKED_GOAL_STATUSES = new Set(["blocked"]);
const RESUMABLE_GOAL_STATUSES = new Set(["active", "blocked"]);
const DEFAULT_CONTINUE_PROMPT =
  "继续完成刚才因上游服务故障而中断的任务。先检查当前状态，不要重复已完成的步骤。";

function parentContinuePrompt(threadId) {
  return `子代理线程 ${threadId} 因上游服务故障中断。请检查该子任务状态，必要时重新派发，并继续完成原任务；不要重复已完成步骤。`;
}

function getExplicitGoal(response) {
  if (
    response === null ||
    typeof response !== "object" ||
    !Object.hasOwn(response, "goal")
  ) {
    return undefined;
  }
  const goal = response.goal;
  if (goal === null) return null;
  if (typeof goal !== "object" || Array.isArray(goal)) return undefined;
  return goal;
}

function newThreadState() {
  return {
    transientTurns: new Map(),
    blockedTurns: new Set(),
    interruptAttempts: new Set(),
    compactionAttempts: new Set(),
    compactedTurns: new Set(),
    finishedTurns: new Set(),
    pending: null,
    activeTurnId: null,
    lastObservedTurnId: null,
    interruptingTurnId: null,
    turnGeneration: 0,
    attempt: 0,
  };
}

export class GoalWatchdogController {
  constructor({
    sendRequest,
    delaysMs = [30_000, 60_000, 120_000, 300_000],
    interruptAfterMs = 120_000,
    schedule = setTimeout,
    cancel = clearTimeout,
    logger = console,
    recoveryGate = null,
    checkBalances = null,
  }) {
    if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
      throw new Error("delaysMs must contain at least one delay");
    }
    if (!Number.isFinite(interruptAfterMs) || interruptAfterMs < 0) {
      throw new Error("interruptAfterMs must be a non-negative number");
    }
    if (
      recoveryGate !== null &&
      (typeof recoveryGate?.beginRecoveryCheck !== "function" ||
        typeof recoveryGate?.waitForRecovery !== "function")
    ) {
      throw new Error("recoveryGate must provide beginRecoveryCheck and waitForRecovery");
    }
    if (checkBalances !== null && typeof checkBalances !== "function") {
      throw new Error("checkBalances must be a function");
    }
    this.sendRequest = sendRequest;
    this.delaysMs = delaysMs;
    this.interruptAfterMs = interruptAfterMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.logger = logger;
    this.recoveryGate = recoveryGate;
    this.checkBalances = checkBalances;
    this.threads = new Map();
    this.threadMetadata = new Map();
    this.pluginRecoveryOwner = null;
  }

  handleNotification(message) {
    if (message?.method === "thread/started") {
      this.#handleThreadStarted(message.params ?? {});
      return;
    }
    if (message?.method === "error") {
      this.#handleError(message);
      return;
    }
    if (message?.method === "thread/compacted" ||
        (message?.method === "item/completed" &&
          message.params?.item?.type === "contextCompaction")) {
      this.#handleContextCompacted(message.params ?? {});
      return;
    }
    if (message?.method?.startsWith("item/")) {
      this.#handleTurnProgress(message.method, message.params ?? {});
      return;
    }
    if (message?.method === "thread/goal/updated") {
      this.#handleGoalUpdated(message.params ?? {});
      return;
    }
    if (message?.method === "thread/goal/cleared") {
      this.#resetThread(message.params?.threadId);
      return;
    }
    if (message?.method === "turn/started") {
      this.#handleTurnStarted(message.params ?? {});
      return;
    }
    if (message?.method === "turn/completed") {
      this.#handleTurnCompleted(message.params ?? {});
    }
  }

  close() {
    for (const [threadId] of this.threads) this.#resetThread(threadId);
    this.threadMetadata.clear();
  }

  #state(threadId) {
    let state = this.threads.get(threadId);
    if (!state) {
      state = newThreadState();
      this.threads.set(threadId, state);
    }
    return state;
  }

  #handleThreadStarted(params) {
    const thread = params.thread;
    if (!thread?.id) return;
    this.threadMetadata.set(thread.id, {
      parentThreadId: typeof thread.parentThreadId === "string"
        ? thread.parentThreadId
        : null,
      canAcceptDirectInput: thread.canAcceptDirectInput,
    });
  }

  #handleTurnStarted(params) {
    const threadId = params.threadId;
    const turnId = params.turnId ?? params.turn?.id;
    if (!threadId || !turnId) return;

    const state = this.#state(threadId);
    state.lastObservedTurnId = turnId;
    if (["compact-request", "compact-wait"].includes(state.pending?.kind)) {
      if (
        state.pending.compactionTurnId &&
        state.pending.compactionTurnId !== turnId
      ) {
        this.#cancelPending(
          state,
          state.pending.kind,
          `new turn ${turnId} replaced compaction turn ${state.pending.compactionTurnId}`,
        );
      } else {
        state.pending.compactionTurnId = turnId;
        state.activeTurnId = turnId;
        return;
      }
    }
    if (state.pending && state.pending.turnId !== turnId) {
      this.#cancelPending(
        state,
        state.pending.kind,
        `new turn ${turnId} started`,
      );
    }
    if (state.activeTurnId && state.activeTurnId !== turnId) {
      this.#cancelPending(state);
      state.transientTurns.clear();
      state.blockedTurns.clear();
      state.interruptAttempts.clear();
      state.compactionAttempts.clear();
      state.compactedTurns.clear();
      state.interruptingTurnId = null;
    }
    if (state.activeTurnId !== turnId) state.turnGeneration += 1;
    state.activeTurnId = turnId;
  }

  #handleTurnProgress(method, params) {
    const { threadId, turnId } = params;
    if (!threadId || !turnId) return;

    const state = this.threads.get(threadId);
    if (state?.pending?.kind !== "interrupt" || state.pending.turnId !== turnId) return;

    this.#cancelPending(state, "interrupt", `turn progress: ${method}`);
    state.transientTurns.delete(turnId);
  }

  #handleError(message) {
    const classification = classifyTerminalError(message);
    if (classification.recoveryAction === "compact") {
      const { threadId, turnId } = message.params ?? {};
      if (threadId && turnId) {
        const state = this.#state(threadId);
        if (state.finishedTurns.has(turnId)) {
          this.logger.info(`Ignored context exhaustion for finished turn ${threadId}/${turnId}`);
          return;
        }
        if (
          state.compactionAttempts.has(turnId) ||
          (state.pending?.kind?.startsWith("compact") && state.pending.turnId === turnId)
        ) {
          this.logger.info(`Ignored duplicate context exhaustion for ${threadId}/${turnId}`);
          return;
        }
        if (state.activeTurnId && state.activeTurnId !== turnId) {
          this.logger.info(`Ignored stale context exhaustion for ${threadId}/${turnId}`);
          return;
        }
        this.#cancelPending(state);
        this.#scheduleCompaction(threadId, turnId, state);
      }
      return;
    }
    const pluginManaged429 = this.recoveryGate !== null && classification.statusCode === 429;
    if (!classification.transient && !pluginManaged429) return;

    const { threadId, turnId } = message.params ?? {};
    if (!threadId || !turnId) {
      this.logger.warn("Ignored transient error without threadId and turnId");
      return;
    }

    const state = this.#state(threadId);
    if (state.finishedTurns.has(turnId)) {
      this.logger.info(`Ignored transient error for finished turn ${threadId}/${turnId}`);
      return;
    }
    if (state.activeTurnId && state.activeTurnId !== turnId) {
      this.logger.info(`Ignored stale transient error for ${threadId}/${turnId}`);
      return;
    }
    const willRetry = classification.willRetry === true ||
      (pluginManaged429 && message.params?.willRetry === true);
    const failure = {
      ...classification,
      error: message.params?.error ?? null,
    };
    if (willRetry) failure.willRetry = true;
    state.transientTurns.set(turnId, failure);
    this.logger.info(
      `Transient error for ${threadId}/${turnId}: ${classification.reason}`,
    );

    if (willRetry && state.blockedTurns.has(turnId)) {
      this.#scheduleIfCorrelated(threadId, turnId, state);
      return;
    }

    if (willRetry) {
      this.#scheduleInterrupt(threadId, turnId, state);
      return;
    }

    this.#cancelPending(state, "interrupt");
    this.#scheduleIfCorrelated(threadId, turnId, state);
  }

  #handleGoalUpdated(params) {
    const threadId = params.threadId;
    const turnId = params.turnId;
    const status = params.goal?.status;
    if (!threadId || !status) return;

    const state = this.#state(threadId);
    if (status === "blocked" && turnId) {
      this.#cancelPending(state, "interrupt");
      state.blockedTurns.add(turnId);
      this.#scheduleIfCorrelated(threadId, turnId, state);
      return;
    }

    if (status === "active") {
      if (state.pending?.kind === "resume" && state.pending.requireBlocked) {
        this.#cancelPending(state, "resume", "blocked goal became active");
      }
      return;
    }
    if (STOPPED_GOAL_STATUSES.has(status)) this.#resetThread(threadId);
  }

  #handleTurnCompleted(params) {
    const threadId = params.threadId;
    const turn = params.turn;
    const turnId = params.turnId ?? turn?.id;
    if (!threadId || !turnId) return;

    const state = this.threads.get(threadId);
    if (!state) return;
    state.finishedTurns.add(turnId);
    if (state.activeTurnId === turnId) state.activeTurnId = null;

    if (turn?.status === "completed" && !turn.error) {
      if (state.pending?.kind?.startsWith("compact")) {
        this.logger.info(
          `Successful turn completed for ${threadId}; context recovery remains pending`,
        );
        return;
      }
      this.#clearSuccessfulTurn(state);
      this.logger.info(`Successful turn completed for ${threadId}; retry delay reset`);
      return;
    }

    const interruptionFinished =
      state.interruptingTurnId === turnId &&
      (turn?.status === "interrupted" ||
        turn?.status === "failed" ||
        (turn?.status === "completed" && Boolean(turn.error)));
    if (interruptionFinished) {
      const failure = state.transientTurns.get(turnId) ?? null;
      state.interruptingTurnId = null;
      state.transientTurns.delete(turnId);
      state.blockedTurns.delete(turnId);
      this.#scheduleResume(threadId, turnId, state, false, failure);
      return;
    }

    const terminalFailure =
      turn?.status === "failed" ||
      (turn?.status === "completed" && Boolean(turn.error));
    if (
      this.recoveryGate &&
      state.transientTurns.has(turnId) &&
      terminalFailure
    ) {
      if (state.pending?.kind === "interrupt" && state.pending.turnId === turnId) {
        this.#cancelPending(
          state,
          "interrupt",
          `turn ${turnId} failed before interrupt`,
        );
      }
      this.#scheduleResume(
        threadId,
        turnId,
        state,
        true,
        state.transientTurns.get(turnId),
      );
    }
  }

  #clearSuccessfulTurn(state) {
    this.#cancelPending(state);
    state.attempt = 0;
    state.activeTurnId = null;
    state.interruptingTurnId = null;
    state.transientTurns.clear();
    state.blockedTurns.clear();
    state.interruptAttempts.clear();
    state.compactionAttempts.clear();
    state.compactedTurns.clear();
  }

  #scheduleCompaction(threadId, turnId, state, retry = false) {
    if (state.compactionAttempts.has(turnId) || state.pending) return;
    const delayMs = retry
      ? this.delaysMs[Math.min(state.attempt, this.delaysMs.length - 1)]
      : 0;
    const pending = {
      kind: "compact",
      threadId,
      handle: null,
      cancelled: false,
      turnId,
    };
    pending.handle = this.schedule(async () => {
      if (pending.cancelled || state.pending !== pending) return;
      await this.#compactAndResume(threadId, turnId, state, pending);
    }, delayMs);
    state.pending = pending;
    this.logger.info(`Context exhausted for ${threadId}/${turnId}; compact in ${delayMs}ms`);
  }

  async #compactAndResume(threadId, turnId, state, pending) {
    try {
      const before = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      const beforeStatus = before?.goal?.status;
      if (STOPPED_GOAL_STATUSES.has(beforeStatus)) {
        this.#releasePending(state, pending);
        return;
      }
      state.compactionAttempts.add(turnId);
      pending.kind = "compact-request";
      await this.sendRequest("thread/compact/start", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending) || state.compactedTurns.has(turnId)) {
        return;
      }
      pending.kind = "compact-wait";
      pending.handle = this.schedule(() => {
        if (!this.#isCurrentPending(threadId, state, pending)) return;
        this.#releasePending(state, pending);
        this.logger.error(
          `Stopped context recovery for ${threadId}/${turnId}: compaction completion timed out`,
        );
      }, this.delaysMs.at(-1));
      this.logger.info(`Waiting for context compaction completion for ${threadId}`);
    } catch (error) {
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      this.#releasePending(state, pending);
      const classification = classifyRecoveryRequestError(error);
      this.logger.error(
        `Failed to compact context for ${threadId}: ${classification.reason}: ${error.message}`,
      );
      if (!classification.retry) {
        return;
      }
      if (![408, 429, 502, 503, 504].includes(error?.code)) {
        this.logger.error(
          `Stopped context recovery for ${threadId}/${turnId}: compaction delivery is uncertain`,
        );
        return;
      }
      state.compactionAttempts.delete(turnId);
      this.#scheduleCompaction(threadId, turnId, state, true);
      state.attempt += 1;
    }
  }

  #handleContextCompacted(params) {
    const threadId = params.threadId;
    if (!threadId) return;
    const state = this.threads.get(threadId);
    const pending = state?.pending;
    if (!pending?.kind?.startsWith("compact")) return;
    if (
      pending.compactionTurnId &&
      params.turnId &&
      params.turnId !== pending.compactionTurnId
    ) return;
    const turnId = pending.turnId;
    state.compactedTurns.add(turnId);
    this.cancel(pending.handle);
    this.#releasePending(state, pending);
    this.#scheduleResumeAfterCompaction(threadId, turnId, state, 0);
  }

  #scheduleResumeAfterCompaction(threadId, turnId, state, delayMs) {
    if (state.pending) return;
    const pending = {
      kind: "compact-resume",
      threadId,
      handle: null,
      cancelled: false,
      turnId,
    };
    pending.handle = this.schedule(async () => {
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      await this.#resumeAfterCompaction(threadId, turnId, state, pending);
    }, delayMs);
    state.pending = pending;
  }

  async #resumeAfterCompaction(threadId, turnId, state, pending) {
    try {
      const after = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      if (after?.goal?.status === "blocked") {
        await this.sendRequest("thread/goal/set", { threadId, status: "active" });
      }
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      this.#releasePending(state, pending);
      state.attempt = 0;
      this.logger.info(`Compacted context and resumed goal ${threadId}`);
    } catch (error) {
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      this.#releasePending(state, pending);
      const classification = classifyRecoveryRequestError(error);
      this.logger.error(`Failed to resume compacted goal ${threadId}: ${classification.reason}`);
      if (!classification.retry) return;
      const delayMs = this.delaysMs[Math.min(state.attempt, this.delaysMs.length - 1)];
      this.#scheduleResumeAfterCompaction(threadId, turnId, state, delayMs);
      state.attempt += 1;
    }
  }

  #scheduleInterrupt(threadId, turnId, state) {
    if (state.interruptAttempts.has(turnId)) return;
    if (state.interruptingTurnId === turnId || state.pending) return;

    const pending = {
      kind: "interrupt",
      threadId,
      handle: null,
      cancelled: false,
      turnId,
      failure: state.transientTurns.get(turnId) ?? null,
      abortController: new AbortController(),
    };
    pending.handle = this.schedule(async () => {
      if (pending.cancelled || state.pending !== pending) return;
      await this.#interruptIfStillEligible(threadId, turnId, state, pending);
    }, this.interruptAfterMs);
    state.pending = pending;
    this.logger.info(
      `Transient retry for ${threadId}/${turnId}; interrupt in ${this.interruptAfterMs}ms`,
    );
  }

  async #interruptIfStillEligible(threadId, turnId, state, pending) {
    if (state.interruptAttempts.has(turnId)) return;
    let interruptSent = false;

    if (!await this.#waitForPluginRecovery(threadId, turnId, state, pending)) return;

    try {
      const response = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      if (!state.transientTurns.has(turnId)) {
        this.#releasePending(state, pending);
        return;
      }
      if (state.activeTurnId && state.activeTurnId !== turnId) {
        this.#releasePending(state, pending);
        return;
      }

      const goal = getExplicitGoal(response);
      const canInterrupt =
        INTERRUPTABLE_GOAL_STATUSES.has(goal?.status) ||
        (goal === null && Boolean(this.recoveryGate)) ||
        (goal?.status === "paused" && state.lastObservedTurnId === turnId);
      if (!canInterrupt) {
        this.#releasePending(state, pending);
        this.logger.info(
          `Thread ${threadId} is not eligible for an automatic interrupt`,
        );
        return;
      }

      state.interruptAttempts.add(turnId);
      state.interruptingTurnId = turnId;
      this.#releasePending(state, pending);
      interruptSent = true;
      await this.sendRequest("turn/interrupt", { threadId, turnId });
      this.logger.info(`Interrupted transient turn ${threadId}/${turnId}`);
    } catch (error) {
      if (!interruptSent) {
        if (!this.#isCurrentPending(threadId, state, pending)) return;
        this.#releasePending(state, pending);
      } else if (state.interruptingTurnId === turnId) {
        state.interruptingTurnId = null;
      }
      this.logger.error(`Failed to interrupt turn ${threadId}/${turnId}: ${error.message}`);
    }
  }

  #scheduleIfCorrelated(threadId, turnId, state) {
    if (state.pending) return;
    if (!state.transientTurns.has(turnId) || !state.blockedTurns.has(turnId)) return;
    this.#scheduleResume(
      threadId,
      turnId,
      state,
      true,
      state.transientTurns.get(turnId),
    );
  }

  #scheduleResume(threadId, turnId, state, requireBlocked, failure = null) {
    if (state.pending) return;

    const delayIndex = Math.min(state.attempt, this.delaysMs.length - 1);
    const delayMs = this.delaysMs[delayIndex];
    const pending = {
      kind: "resume",
      threadId,
      handle: null,
      cancelled: false,
      requireBlocked,
      turnId,
      failure,
      abortController: new AbortController(),
    };
    pending.handle = this.schedule(async () => {
      if (pending.cancelled || state.pending !== pending) return;
      await this.#resumeGoal(threadId, turnId, state, requireBlocked, pending);
    }, delayMs);
    state.pending = pending;
    if (requireBlocked) {
      this.logger.info(
        `Thread ${threadId}/${turnId} recovery scheduled in ${delayMs}ms`,
      );
    } else {
      this.logger.info(`Interrupted turn ${threadId}/${turnId}; resume in ${delayMs}ms`);
    }
  }

  async #resumeGoal(threadId, turnId, state, requireBlocked, pending) {
    let actionSent = false;
    let recoveryAction = null;
    let turnGeneration = null;

    if (!await this.#waitForPluginRecovery(threadId, turnId, state, pending)) return;

    try {
      const response = await this.sendRequest("thread/goal/get", { threadId });
      if (!this.#isCurrentPending(threadId, state, pending)) return;
      if (state.activeTurnId && state.activeTurnId !== turnId) {
        this.#releasePending(state, pending);
        return;
      }

      const goal = getExplicitGoal(response);
      recoveryAction = this.#selectRecoveryAction(
        goal,
        requireBlocked,
        state,
        turnId,
      );
      if (!recoveryAction) {
        this.#releasePending(state, pending);
        this.logger.info(
          `Thread ${threadId} recovery skipped; status is ${goal?.status ?? "unknown"}`,
        );
        return;
      }

      turnGeneration = state.turnGeneration;
      this.#releasePending(state, pending);
      actionSent = true;
      await this.#sendRecoveryAction(recoveryAction, threadId);
      if (!this.#isCurrentTurnGeneration(threadId, state, turnGeneration)) return;
      state.attempt += 1;
      state.transientTurns.delete(turnId);
      state.blockedTurns.delete(turnId);
      state.interruptAttempts.delete(turnId);
      if (recoveryAction === "resume-goal") {
        this.logger.info(`Goal ${threadId} resumed automatically`);
      } else {
        this.logger.info(`Thread ${threadId} continued automatically`);
      }
    } catch (error) {
      if (!actionSent) {
        if (!this.#isCurrentPending(threadId, state, pending)) return;
        this.#releasePending(state, pending);
      } else if (!this.#isCurrentTurnGeneration(threadId, state, turnGeneration)) {
        return;
      }
      const classification = classifyRecoveryRequestError(error);
      if (actionSent && recoveryAction === "continue-turn" && classification.retry) {
        this.logger.error(
          `Thread ${threadId}/${turnId} recovery stopped: turn continuation delivery is uncertain`,
        );
        this.#resetThread(threadId);
        return;
      }
      this.logger.error(`Thread ${threadId} recovery failed: ${error.message}`);
      if (this.threads.get(threadId) !== state) return;
      if (state.activeTurnId && state.activeTurnId !== turnId) return;
      if (!classification.retry) {
        this.logger.error(
          `Thread ${threadId}/${turnId} recovery stopped: ${classification.reason}`,
        );
        this.#resetThread(threadId);
        return;
      }
      state.attempt += 1;
      state.transientTurns.set(turnId, { transient: true, reason: "resume-rpc-failed" });
      state.blockedTurns.add(turnId);
      this.#scheduleResume(threadId, turnId, state, requireBlocked, pending.failure);
    }
  }

  #selectRecoveryAction(goal, requireBlocked, state, turnId) {
    if (goal === null) return this.recoveryGate ? "continue-turn" : null;
    if (goal?.status === "paused" && state.lastObservedTurnId === turnId) {
      return "continue-turn";
    }
    if (goal === undefined) return null;
    const statuses = requireBlocked ? BLOCKED_GOAL_STATUSES : RESUMABLE_GOAL_STATUSES;
    return statuses.has(goal.status) ? "resume-goal" : null;
  }

  #directInputThreadId(threadId) {
    const visited = new Set();
    let currentThreadId = threadId;

    while (this.threadMetadata.get(currentThreadId)?.canAcceptDirectInput === false) {
      if (visited.has(currentThreadId)) {
        throw new Error(`Detected a parent cycle while recovering sub-agent ${threadId}`);
      }
      visited.add(currentThreadId);
      const parentThreadId = this.threadMetadata.get(currentThreadId)?.parentThreadId;
      if (!parentThreadId) {
        throw new Error(`No direct-input parent is known for sub-agent ${threadId}`);
      }
      currentThreadId = parentThreadId;
    }

    return currentThreadId;
  }

  async #sendRecoveryAction(action, threadId) {
    if (action === "resume-goal") {
      return this.sendRequest("thread/goal/set", { threadId, status: "active" });
    }

    const directInputThreadId = this.#directInputThreadId(threadId);
    const delegated = directInputThreadId !== threadId;
    const input = [{
      type: "text",
      text: delegated ? parentContinuePrompt(threadId) : DEFAULT_CONTINUE_PROMPT,
    }];
    if (delegated) {
      this.logger.info(
        `Routing sub-agent recovery from ${threadId} to parent ${directInputThreadId}`,
      );
      const activeTurnId = this.threads.get(directInputThreadId)?.activeTurnId;
      if (activeTurnId) {
        return this.sendRequest("turn/steer", {
          threadId: directInputThreadId,
          expectedTurnId: activeTurnId,
          input,
        });
      }
    }
    return this.sendRequest("turn/start", { threadId: directInputThreadId, input });
  }

  async #waitForPluginRecovery(threadId, turnId, state, pending) {
    if (!this.recoveryGate) return true;
    if (pending.failure?.pluginConfirmed === true) return true;

    let balanceStatus = null;
    try {
      if (pending.failure?.statusCode === 429) {
        balanceStatus = this.checkBalances
          ? await this.checkBalances({
            error: pending.failure.error,
            signal: pending.abortController.signal,
          })
          : "unknown";
        if (!this.#isCurrentPending(threadId, state, pending)) return false;
        if (!["available", "insufficient", "unknown"].includes(balanceStatus)) {
          throw new Error(`Invalid balance status: ${balanceStatus}`);
        }
        if (balanceStatus === "insufficient") {
          this.#releasePending(state, pending);
          state.transientTurns.delete(turnId);
          state.blockedTurns.delete(turnId);
          state.interruptAttempts.delete(turnId);
          this.logger.warn(
            `Stopped thread recovery for ${threadId}/${turnId}: relay balance is insufficient`,
          );
          return false;
        }
      }

      this.#claimPluginRecovery(threadId, state, pending);
      this.recoveryGate.beginRecoveryCheck({
        error: pending.failure?.error ?? null,
        balanceStatus,
      });
      await this.recoveryGate.waitForRecovery();
      if (this.pluginRecoveryOwner?.pending === pending) this.pluginRecoveryOwner = null;
      pending.gateActive = false;
      if (!this.#isCurrentPending(threadId, state, pending)) return false;
      if (pending.failure) {
        pending.failure.pluginConfirmed = true;
        pending.failure.balanceStatus = balanceStatus;
      }
      return true;
    } catch (error) {
      if (this.pluginRecoveryOwner?.pending === pending) this.pluginRecoveryOwner = null;
      pending.gateActive = false;
      if (!this.#isCurrentPending(threadId, state, pending)) return false;
      this.#releasePending(state, pending);
      this.logger.error(
        `Stopped plugin recovery for ${threadId}/${turnId}: ${error?.message ?? error}`,
      );
      return false;
    }
  }

  #claimPluginRecovery(threadId, state, pending) {
    const previous = this.pluginRecoveryOwner;
    if (previous && previous.pending !== pending) {
      this.#cancelPending(
        previous.state,
        previous.pending.kind,
        `plugin recovery superseded by ${threadId}/${pending.turnId}`,
      );
    }
    pending.gateActive = true;
    this.pluginRecoveryOwner = { threadId, state, pending };
  }

  #isCurrentPending(threadId, state, pending) {
    return (
      !pending.cancelled &&
      state.pending === pending &&
      this.threads.get(threadId) === state
    );
  }

  #isCurrentTurnGeneration(threadId, state, turnGeneration) {
    return (
      this.threads.get(threadId) === state &&
      state.turnGeneration === turnGeneration
    );
  }

  #releasePending(state, pending) {
    if (state.pending === pending) state.pending = null;
  }

  #cancelPending(state, kind = null, reason = null) {
    if (!state.pending || (kind && state.pending.kind !== kind)) return;
    const pending = state.pending;
    pending.cancelled = true;
    this.cancel(pending.handle);
    pending.abortController?.abort(new Error("Pending recovery was cancelled"));
    if (pending.gateActive) {
      this.recoveryGate?.cancelRecoveryCheck?.();
      if (this.pluginRecoveryOwner?.pending === pending) this.pluginRecoveryOwner = null;
      pending.gateActive = false;
    }
    state.pending = null;
    if (reason) {
      this.logger.info(
        `Cancelled pending ${pending.kind} for ${pending.threadId}/${pending.turnId}: ${reason}`,
      );
    }
  }

  #resetThread(threadId) {
    if (!threadId) return;
    const state = this.threads.get(threadId);
    if (!state) return;
    this.#cancelPending(state);
    this.threads.delete(threadId);
  }
}
