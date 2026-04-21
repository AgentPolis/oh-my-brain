import { describe, expect, it } from "vitest";
import {
  analyzeQuestion,
  buildDeterministicAnswer,
  buildInsufficientAnswer,
  collectRelevantSnippets,
} from "../scripts/longmemeval-lib.mjs";

describe("LongMemEval planner helpers", () => {
  it("forces abstention when an _abs question mentions a missing entity", () => {
    const instance = {
      question_id: "sample_abs",
      question_type: "temporal-reasoning",
      question:
        "How many days before I bought my iPad did I attend the Holiday Market?",
      haystack_dates: ["2023/04/10 (Mon) 17:50"],
      haystack_sessions: [
        [
          {
            role: "user",
            content:
              "I attended the Holiday Market and later bought the iPhone 13 Pro.",
          },
        ],
      ],
    };

    const analysis = analyzeQuestion(instance);
    expect(analysis.shouldForceAbstain).toBe(true);
    expect(analysis.missingEntities).toContain("iPad");
    expect(buildInsufficientAnswer(instance, analysis)).toContain("iPad");
  });

  it("collects relevant snippets for question-aware prompting", () => {
    const instance = {
      question_id: "sample",
      question_type: "multi-session",
      question: "How many projects have I led or am currently leading?",
      haystack_dates: ["2023/04/10 (Mon) 17:50", "2023/04/11 (Tue) 11:00"],
      haystack_sessions: [
        [
          {
            role: "user",
            content: "I led the migration project last quarter.",
          },
          {
            role: "assistant",
            content: "That migration project sounds intense.",
          },
        ],
        [
          {
            role: "user",
            content: "I am currently leading the mobile redesign project too.",
          },
        ],
      ],
    };

    const snippets = collectRelevantSnippets(instance, 5);
    expect(snippets.length).toBeGreaterThan(0);
    expect(snippets.some((entry) => entry.content.includes("leading the mobile redesign"))).toBe(
      true
    );
  });

  it("treats relation-specific entities as missing when only a different relation is mentioned", () => {
    const instance = {
      question_id: "google_job_abs",
      question_type: "temporal-reasoning",
      question: "How long have I been working before I started my current job at Google?",
      haystack_dates: ["2023/05/23 (Tue) 05:40"],
      haystack_sessions: [
        [
          {
            role: "user",
            content:
              "I've been working at NovaTech for about 4 years and 3 months now.",
          },
          {
            role: "assistant",
            content:
              "Google Calendar is still my favorite scheduling tool for tracking long commutes.",
          },
        ],
      ],
    };

    const analysis = analyzeQuestion(instance);
    expect(analysis.shouldForceAbstain).toBe(true);
    expect(analysis.missingEntities).toContain("Google");
  });

  it("matches comparison options across simple wording changes", () => {
    const instance = {
      question_id: "comparison_sample",
      question_type: "temporal-reasoning",
      question:
        "Which task did I complete first, fixing the fence or trimming the goats' hooves?",
      haystack_dates: ["2023/05/22 (Mon) 20:15", "2023/05/22 (Mon) 18:29"],
      haystack_sessions: [
        [
          {
            role: "user",
            content:
              "I just fixed that broken fence on the east side of my property three weeks ago.",
          },
        ],
        [
          {
            role: "user",
            content:
              "I've been doing a great job of keeping up with the goat's hoove trimming, I did it two weeks ago.",
          },
        ],
      ],
    };

    const analysis = analyzeQuestion(instance);
    expect(analysis.missingOptions).toEqual([]);
    expect(analysis.optionEvidence.every((item) => item.snippets.length > 0)).toBe(true);
  });

  it("collects aggregate candidates for 'which ... most' questions", () => {
    const instance = {
      question_id: "aggregate_choice_sample",
      question_type: "temporal-reasoning",
      question: "Which airline did I fly with the most in March and April?",
      haystack_dates: ["2023/04/27 (Thu) 13:15", "2023/04/27 (Thu) 05:20"],
      haystack_sessions: [
        [
          {
            role: "user",
            content:
              "In March, I took a business trip to Chicago with United Airlines, flying from my hometown to Chicago on the 10th and returning on the 12th.",
          },
          {
            role: "user",
            content:
              "I'm planning a future trip and I'm trying to decide between United Airlines and American Airlines.",
          },
        ],
        [
          {
            role: "user",
            content:
              "We flew with American Airlines from our hometown to Honolulu, and then took a connecting flight to Maui.",
          },
        ],
      ],
    };

    const analysis = analyzeQuestion(instance);
    expect(analysis.intent).toBe("aggregate_choice");
    expect(analysis.aggregateCandidates[0]).toEqual({ entity: "United Airlines", count: 2 });
  });

  it("classifies ordered-trip questions as sequence intent", () => {
    const instance = {
      question_id: "sequence_sample",
      question_type: "temporal-reasoning",
      question: "What is the order of the three trips I took in the past three months, from earliest to latest?",
      haystack_dates: [],
      haystack_sessions: [],
    };

    const analysis = analyzeQuestion(instance);
    expect(analysis.intent).toBe("sequence");
  });

  it("does not treat yes-no question stems as entities", () => {
    const instance = {
      question_id: "yes_no_sample",
      question_type: "multi-session",
      question:
        "Did I receive a higher percentage discount on my first order from HelloFresh, compared to my first UberEats order?",
      haystack_dates: [],
      haystack_sessions: [],
    };

    const analysis = analyzeQuestion(instance);
    expect(analysis.intent).toBe("yes_no");
    expect(analysis.questionEntities).not.toContain("Did I");
  });

  it("collects date candidates for date lookup questions", () => {
    const instance = {
      question_id: "date_lookup_sample",
      question_type: "multi-session",
      question: "When did I submit my research paper on sentiment analysis?",
      haystack_dates: ["2023/05/23 (Tue) 10:58", "2023/05/25 (Thu) 02:42"],
      haystack_sessions: [
        [
          {
            role: "user",
            content:
              "I even worked on a research paper on sentiment analysis, which I submitted to ACL.",
          },
        ],
        [
          {
            role: "user",
            content:
              "I'm reviewing for ACL, and their submission date was February 1st.",
          },
        ],
      ],
    };

    const analysis = analyzeQuestion(instance);
    expect(analysis.dateCandidates.some((item) => item.content.includes("February 1st"))).toBe(true);
  });

  it("collects percentage comparisons for yes-no discount questions", () => {
    const instance = {
      question_id: "yes_no_discount_sample",
      question_type: "multi-session",
      question:
        "Did I receive a higher percentage discount on my first order from HelloFresh, compared to my first UberEats order?",
      haystack_dates: ["2023/05/25 (Thu) 22:22", "2023/05/27 (Sat) 23:58"],
      haystack_sessions: [
        [
          {
            role: "user",
            content:
              "I recently tried HelloFresh and got a 40% discount on my first order.",
          },
        ],
        [
          {
            role: "user",
            content:
              "Last week I got 20% off my UberEats order, which was awesome!",
          },
        ],
      ],
    };

    const analysis = analyzeQuestion(instance);
    expect(analysis.comparisonValues.some((item) => item.entity === "HelloFresh" && item.values.includes(40))).toBe(true);
    expect(analysis.comparisonValues.some((item) => item.entity === "UberEats" && item.values.includes(20))).toBe(true);
    expect(buildDeterministicAnswer(instance, analysis)).toBe("Yes.");
  });
});
