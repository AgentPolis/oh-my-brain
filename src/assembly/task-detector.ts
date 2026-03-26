/**
 * Task type detection with exponential moving average blending.
 */

import type { StoredMessage, TaskType, TaskWeights } from "../types.js";
import { DEFAULT_TASK_WEIGHTS } from "../types.js";

export interface TaskDetectorConfig {
  blendTurns: number;
  newWeight: number;
}

interface TaskState {
  current: TaskType;
  blendedWeights: TaskWeights;
  consecutiveCount: number;
  previous: TaskType | null;
  turnsInTransition: number;
}

export class TaskDetector {
  private config: TaskDetectorConfig;
  private state: TaskState;

  constructor(config: TaskDetectorConfig) {
    this.config = config;
    this.state = {
      current: "chat",
      blendedWeights: { ...DEFAULT_TASK_WEIGHTS.chat },
      consecutiveCount: 0,
      previous: null,
      turnsInTransition: 0,
    };
  }

  get currentTask(): TaskType {
    return this.state.current;
  }

  get weights(): TaskWeights {
    return this.state.blendedWeights;
  }

  /**
   * Detect task type from recent messages and update blended weights.
   */
  detect(recentMessages: StoredMessage[]): TaskType {
    const detected = inferTaskType(recentMessages);

    if (detected === this.state.current) {
      this.state.consecutiveCount++;
      this.state.turnsInTransition = 0;

      // Fully transitioned — use pure weights
      if (this.state.consecutiveCount >= this.config.blendTurns) {
        this.state.blendedWeights = { ...DEFAULT_TASK_WEIGHTS[detected] };
      }
    } else {
      // Task type changed — start blending
      this.state.previous = this.state.current;
      this.state.current = detected;
      this.state.consecutiveCount = 1;
      this.state.turnsInTransition = 1;

      // Blend: new 0.6 + old 0.4
      const newW = DEFAULT_TASK_WEIGHTS[detected];
      const oldW = DEFAULT_TASK_WEIGHTS[this.state.previous];
      const nw = this.config.newWeight;
      const ow = 1 - nw;

      this.state.blendedWeights = {
        history: newW.history * nw + oldW.history * ow,
        toolResults: newW.toolResults * nw + oldW.toolResults * ow,
        directives: newW.directives * nw + oldW.directives * ow,
      };
    }

    return detected;
  }

  /**
   * Force-set a task type (for `/squeeze task set <type>`).
   */
  override(task: TaskType): void {
    this.state.current = task;
    this.state.blendedWeights = { ...DEFAULT_TASK_WEIGHTS[task] };
    this.state.consecutiveCount = this.config.blendTurns;
    this.state.turnsInTransition = 0;
  }
}

// ── Heuristic task inference ─────────────────────────────────────

const SIGNALS: Record<TaskType, RegExp[]> = {
  coding: [
    /\b(function|class|import|export|const|let|var|def|fn|return)\b/,
    /\.(ts|js|py|rs|go|java|rb|cpp|c|sh)\b/,
    /```[\s\S]{20,}```/,
  ],
  debug: [
    /\b(error|Error|ERROR|exception|stack trace|traceback|failed|FAIL)\b/,
    /\bat line \d+/,
    /\b(TypeError|ReferenceError|SyntaxError|RuntimeError)\b/,
  ],
  research: [
    /\b(search|find|look up|google|fetch|browse|documentation|docs)\b/i,
    /https?:\/\/\S{15,}/,
  ],
  planning: [
    /\b(plan|design|architecture|roadmap|milestone|phase|step \d)\b/i,
    /\b(should we|what if|how about|strategy|approach)\b/i,
  ],
  chat: [], // fallback
};

const TOOL_SIGNALS: Record<string, TaskType> = {
  bash: "coding",
  read: "coding",
  write: "coding",
  edit: "coding",
  grep: "coding",
  glob: "coding",
  web_search: "research",
  web_fetch: "research",
};

function inferTaskType(messages: StoredMessage[]): TaskType {
  const scores: Record<TaskType, number> = {
    coding: 0,
    debug: 0,
    research: 0,
    planning: 0,
    chat: 0,
  };

  for (const msg of messages) {
    const content = msg.content;

    // Tool-based signals
    if (msg.role === "tool" || msg.contentType === "tool_result") {
      // Check tool name patterns in content
      for (const [toolPattern, taskType] of Object.entries(TOOL_SIGNALS)) {
        if (content.toLowerCase().includes(toolPattern)) {
          scores[taskType] += 2;
        }
      }
    }

    // Content-based signals
    for (const [taskType, patterns] of Object.entries(SIGNALS)) {
      for (const pattern of patterns) {
        if (pattern.test(content)) {
          scores[taskType as TaskType] += 1;
        }
      }
    }

    // Error content → debug
    if (msg.contentType === "tool_result" && /error|fail/i.test(content)) {
      scores.debug += 3;
    }
  }

  // Find highest scoring task type
  let maxScore = 0;
  let detected: TaskType = "chat";

  for (const [taskType, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      detected = taskType as TaskType;
    }
  }

  return detected;
}
