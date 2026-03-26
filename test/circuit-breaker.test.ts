import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  const config = {
    classifierFailThreshold: 3,
    latencyFailThreshold: 5,
    latencyHardLimitMs: 2000,
    recoveryCheckInterval: 10,
  };

  it("starts in non-degraded state", () => {
    const cb = new CircuitBreaker(config);
    expect(cb.isDegraded).toBe(false);
    expect(cb.degradedReason).toBeNull();
  });

  it("degrades after classifier failures exceed threshold", () => {
    const cb = new CircuitBreaker(config);
    cb.recordClassifierFailure();
    cb.recordClassifierFailure();
    expect(cb.isDegraded).toBe(false);

    cb.recordClassifierFailure(); // 3rd = threshold
    expect(cb.isDegraded).toBe(true);
    expect(cb.degradedReason).toBe("classifier_unavailable");
  });

  it("recovers after classifier success", () => {
    const cb = new CircuitBreaker(config);
    cb.recordClassifierFailure();
    cb.recordClassifierFailure();
    cb.recordClassifierFailure();
    expect(cb.isDegraded).toBe(true);

    cb.recordClassifierSuccess();
    expect(cb.isDegraded).toBe(false);
  });

  it("degrades after repeated high latency", () => {
    const cb = new CircuitBreaker(config);
    for (let i = 0; i < 5; i++) {
      cb.recordTurnLatency(3000); // > 2000ms limit
    }
    expect(cb.isDegraded).toBe(true);
    expect(cb.degradedReason).toBe("latency_exceeded");
  });

  it("recovers after normal latency", () => {
    const cb = new CircuitBreaker(config);
    for (let i = 0; i < 5; i++) {
      cb.recordTurnLatency(3000);
    }
    expect(cb.isDegraded).toBe(true);

    cb.recordTurnLatency(100); // normal
    expect(cb.isDegraded).toBe(false);
  });

  it("tick returns true at recovery check intervals", () => {
    const cb = new CircuitBreaker(config);
    cb.recordStorageFailure();

    for (let i = 1; i <= 9; i++) {
      expect(cb.tick()).toBe(false);
    }
    expect(cb.tick()).toBe(true); // 10th tick
  });

  it("reset clears all state", () => {
    const cb = new CircuitBreaker(config);
    cb.recordStorageFailure();
    expect(cb.isDegraded).toBe(true);

    cb.reset();
    expect(cb.isDegraded).toBe(false);
  });
});
