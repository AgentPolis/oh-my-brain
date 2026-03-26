/**
 * Circuit breaker: tracks failures and decides when to degrade.
 */

export interface CircuitBreakerConfig {
  classifierFailThreshold: number;
  latencyFailThreshold: number;
  latencyHardLimitMs: number;
  recoveryCheckInterval: number;
}

export type DegradedReason =
  | "classifier_unavailable"
  | "latency_exceeded"
  | "storage_failure"
  | null;

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private classifierFailCount = 0;
  private latencyFailCount = 0;
  private turnsSinceDegraded = 0;
  private _degraded: DegradedReason = null;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  get isDegraded(): boolean {
    return this._degraded !== null;
  }

  get degradedReason(): DegradedReason {
    return this._degraded;
  }

  recordClassifierFailure(): void {
    this.classifierFailCount++;
    if (this.classifierFailCount >= this.config.classifierFailThreshold) {
      this._degraded = "classifier_unavailable";
      this.turnsSinceDegraded = 0;
    }
  }

  recordClassifierSuccess(): void {
    this.classifierFailCount = 0;
    if (this._degraded === "classifier_unavailable") {
      this._degraded = null;
    }
  }

  recordTurnLatency(ms: number): void {
    if (ms > this.config.latencyHardLimitMs) {
      this.latencyFailCount++;
      if (this.latencyFailCount >= this.config.latencyFailThreshold) {
        this._degraded = "latency_exceeded";
        this.turnsSinceDegraded = 0;
      }
    } else {
      this.latencyFailCount = 0;
      if (this._degraded === "latency_exceeded") {
        this._degraded = null;
      }
    }
  }

  recordStorageFailure(): void {
    this._degraded = "storage_failure";
    this.turnsSinceDegraded = 0;
  }

  /**
   * Call once per turn. If degraded, increments counter and
   * returns true when it's time to attempt recovery.
   */
  tick(): boolean {
    if (!this._degraded) return false;

    this.turnsSinceDegraded++;
    return this.turnsSinceDegraded % this.config.recoveryCheckInterval === 0;
  }

  /**
   * Attempt recovery — caller should retry the failing component
   * and call the appropriate recordSuccess method.
   */
  attemptRecovery(): void {
    // Reset counters to give the component a fresh chance
    this.classifierFailCount = 0;
    this.latencyFailCount = 0;
  }

  reset(): void {
    this.classifierFailCount = 0;
    this.latencyFailCount = 0;
    this.turnsSinceDegraded = 0;
    this._degraded = null;
  }
}
