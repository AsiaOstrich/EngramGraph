/**
 * Pluggable SAGE signal-source adapter.
 *
 * A signal source produces generic {@link FeedbackEvent}s that the SAGE writer
 * (Phase 4) consumes to evolve node confidence. Core stays host-agnostic:
 * the defaults below describe generic producers (git history, local test exit
 * codes). A host pipeline pass/fail adapter is a reference impl (Phase 6).
 */

/** Direction/strength hint for a feedback event. */
export type FeedbackSignal = "positive" | "negative" | "neutral";

/**
 * Generic feedback event. `weight` in [0, 1] scales the confidence delta;
 * `signal` sets its direction. `nodeId` targets any graph node.
 */
export interface FeedbackEvent {
  nodeId: string;
  signal: FeedbackSignal;
  weight: number;
  /** Optional free-form origin tag (e.g. "git", "vitest", "vibeops"). */
  source?: string;
}

/** A producer of feedback events. */
export interface SignalSource {
  /** Collect any pending feedback events. */
  collect(): Promise<FeedbackEvent[]>;
}

/**
 * Default generic producers (Phase 1: interface + no-op stubs).
 *
 * Phase 4 wires concrete git-history / test-runner producers; for now these
 * establish the contract without baking in any environment assumption.
 */

/** Stub: would derive co-change / commit-frequency signals from git history. */
export class GitHistorySignalSource implements SignalSource {
  async collect(): Promise<FeedbackEvent[]> {
    // Phase 4: walk `git log` and emit co-change/frequency signals.
    return [];
  }
}

/** Stub: would map a local test runner's exit code to pass/fail signals. */
export class TestExitCodeSignalSource implements SignalSource {
  async collect(): Promise<FeedbackEvent[]> {
    // Phase 4: translate test runner exit codes into node feedback events.
    return [];
  }
}
