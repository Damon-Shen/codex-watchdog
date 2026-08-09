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
    interruptingTurnId: null,
    turnGeneration: 0,
    attempt: 0,
    consecutive429Turns: 0,
    lastFailureTurnId: null,
    lastFailureWas429: false,
    lastRecoveryCheckTurnId: null,
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
  }) {
    if (!Array.isArray(delaysMs) || delaysMs.length === 0) {
      throw new Error("delaysMs must contain at least one delay");
    }
    if (!Number.isFinite(interruptAfterMs) || interruptAfterMs < 0) {
      throw new Error("interruptAfterMs must be a non-negative number");
    }
    this.sendRequest = sendRequest;
    this.delaysMs = delaysMs;
    this.interruptAfterMs = interruptAfterMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.logger = logger;
    this.recoveryGate = recoveryGate;
    this.threads = new Map();
    this.threadMetadata = new Map();
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

  #recoveryModeForTurn(state, turnId) {
    return state.transientTurns.get(turnId)?.recoveryMode;
  }

  #beginRecoveryCheckForTurn(state, turnId) {
    if (state.lastRecoveryCheckTurnId === turnId) return;
    state.lastRecoveryCheckTurnId = turnId;
    this.recoveryGate?.beginRecoveryCheck?.();
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
    const startsNewTurn = state.activeTurnId !== turnId;
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
    state.activeTurnId = turnId;
    if (startsNewTurn) state.turnGeneration += 1;
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
        this.#recordFailureKind(state, turnId, classification);
        state.transientTurns.delete(turnId);
        this.#beginRecoveryCheckForTurn(state, turnId);
        this.#cancelPending(state);
        this.#scheduleCompaction(threadId, turnId, state);
      }
      return;
    }
    if (!classification.transient) return;

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
    if (classification.recoveryMode !== "immediate") {
      this.#beginRecoveryCheckForTurn(state, turnId);
    }
    this.#recordFailureKind(state, turnId, classification);
    state.transientTurns.set(turnId, classification);
    if (
      this.#recoveryModeForTurn(state, turnId) === "immediate" &&
      state.pending?.kind === "resume" &&
      state.pending.turnId === turnId &&
      state.pending.recoveryMode !== "immediate"
    ) {
      this.#cancelPending(state, "resume");
    }
    this.logger.info(
      `Transient error for ${threadId}/${turnId}: ${classification.reason}`,
    );

    if (classification.willRetry === true && state.blockedTurns.has(turnId)) {
      this.#scheduleIfCorrelated(threadId, turnId, state);
      return;
    }

    if (classification.willRetry === true) {
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

    const state = this.#state(threadId);
    state.finishedTurns.add(turnId);
    if (state.activeTurnId === turnId) state.activeTurnId = null;

    if (turn?.status === "completed" && !turn.error) {
      this.#reset429Tracking(state);
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
      state.interruptingTurnId = null;
      state.blockedTurns.delete(turnId);
      this.#scheduleResume(threadId, turnId, state, false);
      return;
    }

    const terminalFailure =
      turn?.status === "failed" ||
      (turn?.status === "completed" && Boolean(turn.error));
    const recoveryMode = this.#recoveryModeForTurn(state, turnId);
    if (
      (this.recoveryGate || recoveryMode === "immediate") &&
      state.transientTurns.has(turnId) &&
      terminalFailure
    ) {
      if (
        state.pending?.kind === "interrupt" &&
        state.pending.turnId === turnId
      ) {
        this.#cancelPending(
          state,
          "interrupt",
          `turn ${turnId} failed before interrupt`,
        );
      }
      this.#scheduleResume(threadId, turnId, state, true);
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

  #reset429Tracking(state) {
    state.consecutive429Turns = 0;
    state.lastFailureTurnId = null;
    state.lastFailureWas429 = false;
  }

  #recordFailureKind(state, turnId, classification) {
    if (state.lastFailureTurnId === turnId) {
      if (classification.statusCode !== 429) {
        state.consecutive429Turns = 0;
        state.lastFailureWas429 = false;
      }
      return;
    }

    state.lastFailureTurnId = turnId;
    if (classification.statusCode === 429) {
      state.consecutive429Turns = state.lastFailureWas429
        ? state.consecutive429Turns + 1
        : 1;
      state.lastFailureWas429 = true;
      return;
    }

    state.consecutive429Turns = 0;
    state.lastFailureWas429 = false;
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
    let actionSent = false;
    let recoveryAction = null;
    let turnGeneration = null;

    try {
      const recovery = await this.#resolveRecoveryAction(
        threadId,
        state,
        pending,
        BLOCKED_GOAL_STATUSES,
      );
      if (!recovery) return;
      turnGeneration = state.turnGeneration;
      this.#releasePending(state, pending);
      if (!recovery.action) {
        this.logger.info(
          `Compacted context for ${threadId}; automatic recovery skipped`,
        );
        return;
      }
      if (this.#shouldStopForPossibleDailyLimit(state, turnId, recovery)) {
        this.#resetThread(threadId);
        this.logger.info(
          `Stopped automatic recovery for ${threadId}/${turnId}: possible daily limit`,
        );
        return;
      }
      recoveryAction = recovery.action;
      actionSent = true;
      await this.#sendRecoveryAction(recoveryAction, threadId);
      if (!this.#isCurrentTurnGeneration(threadId, state, turnGeneration)) return;
      state.attempt = 0;
      if (recoveryAction === "resume-goal") {
        this.logger.info(`Compacted context and resumed goal ${threadId}`);
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
      if (
        actionSent &&
        recoveryAction === "continue-turn" &&
        classification.retry
      ) {
        this.logger.error(
          `Thread ${threadId}/${turnId} recovery after compaction stopped: turn/start delivery is uncertain`,
        );
        this.#resetThread(threadId);
        return;
      }
      this.logger.error(
        `Thread ${threadId} recovery after compaction failed: ${classification.reason}`,
      );
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
        (goal === null && Boolean(this.recoveryGate));
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
      const classification = classifyRecoveryRequestError(error);
      if (!interruptSent) {
        if (!this.#isCurrentPending(threadId, state, pending)) return;
        this.#releasePending(state, pending);
      } else if (
        !classification.retry &&
        state.interruptingTurnId === turnId
      ) {
        state.interruptingTurnId = null;
      }
      this.logger.error(`Failed to interrupt turn ${threadId}/${turnId}: ${error.message}`);
    }
  }

  #scheduleIfCorrelated(threadId, turnId, state) {
    if (state.pending) return;
    if (!state.transientTurns.has(turnId) || !state.blockedTurns.has(turnId)) return;
    this.#scheduleResume(threadId, turnId, state, true);
  }

  #selectRecoveryAction(goal, resumableStatuses, recoveryMode) {
    if (goal === null) {
      return this.recoveryGate || recoveryMode === "immediate"
        ? "continue-turn"
        : null;
    }
    if (goal === undefined) return null;
    return resumableStatuses.has(goal.status) ? "resume-goal" : null;
  }

  async #resolveRecoveryAction(threadId, state, pending, resumableStatuses) {
    let gateOutcome = null;
    const recoveryMode = pending.recoveryMode;
    let response = await this.sendRequest("thread/goal/get", { threadId });
    if (!this.#isCurrentPending(threadId, state, pending)) return null;
    let goal = getExplicitGoal(response);
    let action = this.#selectRecoveryAction(goal, resumableStatuses, recoveryMode);
    if (recoveryMode === "immediate" || !action || !this.recoveryGate) {
      return { action, status: goal?.status, gateOutcome };
    }

    this.logger.info(`Waiting for model recovery before recovering thread ${threadId}`);
    gateOutcome = await this.recoveryGate.waitForRecovery();
    if (!this.#isCurrentPending(threadId, state, pending)) return null;
    response = await this.sendRequest("thread/goal/get", { threadId });
    if (!this.#isCurrentPending(threadId, state, pending)) return null;
    goal = getExplicitGoal(response);
    action = this.#selectRecoveryAction(goal, resumableStatuses, recoveryMode);
    return { action, status: goal?.status, gateOutcome };
  }

  #shouldStopForPossibleDailyLimit(state, turnId, recovery) {
    return (
      recovery.gateOutcome === "confirmed-healthy" &&
      state.consecutive429Turns >= 2 &&
      state.transientTurns.get(turnId)?.statusCode === 429
    );
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
    return this.sendRequest("turn/start", {
      threadId: directInputThreadId,
      input,
    });
  }

  #scheduleResume(threadId, turnId, state, requireBlocked, recoveryRequestRetry = false) {
    if (state.pending) return;

    const recoveryMode = this.#recoveryModeForTurn(state, turnId);
    const delayIndex = Math.min(state.attempt, this.delaysMs.length - 1);
    const gateOwnsDelay = Boolean(this.recoveryGate) && !recoveryRequestRetry;
    const delayMs = recoveryMode === "immediate" || gateOwnsDelay
      ? 0
      : this.delaysMs[delayIndex];
    const pending = {
      kind: "resume",
      threadId,
      handle: null,
      cancelled: false,
      recoveryMode,
      requireBlocked,
      turnId,
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

    try {
      const resumableStatuses = requireBlocked
        ? BLOCKED_GOAL_STATUSES
        : RESUMABLE_GOAL_STATUSES;
      const recovery = await this.#resolveRecoveryAction(
        threadId,
        state,
        pending,
        resumableStatuses,
      );
      if (!recovery) return;
      if (state.activeTurnId && state.activeTurnId !== turnId) {
        this.#releasePending(state, pending);
        return;
      }

      if (!recovery.action) {
        this.#releasePending(state, pending);
        this.logger.info(
          `Thread ${threadId} recovery skipped; status is ${recovery.status ?? "unknown"}`,
        );
        return;
      }

      if (this.#shouldStopForPossibleDailyLimit(state, turnId, recovery)) {
        this.#releasePending(state, pending);
        this.#resetThread(threadId);
        this.logger.info(
          `Stopped automatic recovery for ${threadId}/${turnId}: possible daily limit`,
        );
        return;
      }

      recoveryAction = recovery.action;
      turnGeneration = state.turnGeneration;
      this.#releasePending(state, pending);
      actionSent = true;
      await this.#sendRecoveryAction(recoveryAction, threadId);
      if (!this.#isCurrentTurnGeneration(threadId, state, turnGeneration)) return;
      if (pending.recoveryMode !== "immediate") state.attempt += 1;
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
      if (
        actionSent &&
        recoveryAction === "continue-turn" &&
        classification.retry
      ) {
        this.logger.error(
          `Thread ${threadId}/${turnId} recovery stopped: turn/start delivery is uncertain`,
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
      state.blockedTurns.add(turnId);
      this.#scheduleResume(threadId, turnId, state, requireBlocked, true);
    }
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
