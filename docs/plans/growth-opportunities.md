# Growth Opportunities — oh-my-brain v0.4+

> CEO review (2026-04-13) 產出的機會清單。
> 按優先級排序，附帶執行計劃。

---

## Opportunity 1: Decision Replay 開源 Benchmark (v0.4, P0)

**目標：** 定義 benchmark 的人贏了規則制定權。

把 Decision Replay 包裝成獨立的開源 benchmark，不只是 oh-my-brain
的 eval。任何記憶系統都可以跑。

**為什麼這是最大的機會：**
- LongMemEval (2024) 測 retrieval accuracy — 「你記得嗎？」
- MemBench (2025) 測 memory capacity — 「你能更新嗎？」
- **DecisionEval (2026) 測 decision accuracy — 「你懂我嗎？」**
- 沒人做過。我們定義標準。

**執行：**
1. 把 `eval/decision-replay/` 獨立成 npm package `decision-eval`
2. Scenario schema 標準化（situation + options + expected + rationale）
3. 內建 20+ scenarios 覆蓋 5 種決策類型
4. 任何記憶系統都可以 adapter 接入
5. README: "Does your AI agent think like you? Benchmark it."
6. 同時發到 HN + Twitter + MCP marketplace

**Effort:** M (human ~2 days / CC ~30 min)

---

## Opportunity 2: brain_quiz 病毒式傳播 (v0.4, P1)

**目標：** demo-first growth hack。

不是叫人讀 README，是讓人直接體驗。

**機制：**
```
"你的 AI 有多懂你？跑 brain_quiz 測一下。"
→ 結果: "我的 AI 在 10 個決策裡跟我想法一致 8 個 🧠"
→ 分享到 Twitter/LinkedIn
```

兩種結果都驅動使用：
- 高分 → 「太酷了」→ 分享
- 低分 → 「我要教它」→ 開始用

**執行：**
1. brain_quiz 已有（v0.3.1 Task 9），需要擴充 scenario 到 20+
2. 加 `oh-my-brain quiz --share` 產生可分享的文字/圖片
3. 加 quiz 結果的 persistent score tracking（.squeeze/quiz-history.jsonl）
4. README 放 badge: "Decision Match: 85%"

**Effort:** S (human ~4 hours / CC ~15 min)

---

## Opportunity 3: Memory Diff — Weekly Digest (v0.4.1, P1)

**目標：** 讓成長可見。

解決「裝了之後到底有沒有在學」的問題。

**輸出：**
```bash
oh-my-brain diff --since "last week"

本週變化：
  + 學到 3 條新 directive
  + 自動存了 5 條高信心規則
  + 2 條 candidate 等你 review
  - 退休了 1 條過時規則
  ⚠ 發現 1 組矛盾的 directives

你的大腦正在以 2.3 條/天 的速度成長。
歷史: 第1週 +8 | 第2週 +5 | 第3週 +3 (穩定中)
```

**執行：**
1. `oh-my-brain diff` CLI command（讀 actions.jsonl 計算 delta）
2. `brain_diff` MCP tool（agent 可以主動報告）
3. Growth rate 計算（條/天，趨勢方向）
4. Conflict detection 整合（已有 contradicts links）

**Effort:** S (human ~3 hours / CC ~10 min)

---

## Opportunity 4: Brain Profile 匯出 (v0.5, P2)

**目標：** 從 memory 到 identity。

```bash
oh-my-brain profile

決策風格：保守偏執型
  - 安全 > 速度 (3 directives)
  - 自建 > 外包 (2 directives)
  - 小團隊 monolith (1 directive)
偏好：TypeScript strict, tabs, 中文溝通
決策一致性：Decision Replay 85% match
```

你換公司 / 換 AI 工具，帶著 brain profile，新環境第一天就像合作
三年。

**執行：**
1. 分析 directive 集合，歸類成決策維度
2. 每個維度算出傾向（保守/激進、自建/外包等）
3. 匯出成 markdown 或 JSON
4. `brain_profile` MCP tool
5. Import profile 到新 project

**Effort:** M (human ~1 day / CC ~20 min)

---

## Opportunity 5: 匿名 Decision Pattern Intelligence (v1.0+, P3)

**目標：** developer decision intelligence。

如果 1000 個 TypeScript 開發者的 decision patterns 匿名聚合：

```
"87% 的 TypeScript 開發者選擇 strict mode"
"63% 偏好 monolith 到 team > 5 人"
"91% 認為安全比速度重要"
```

可以賣給工具公司：「你的 IDE default 跟 87% 用戶偏好不一致」。

**執行：** 需要足夠用戶量。先不做，先記下來。

**Effort:** XL

---

## 不該追的事

- **LongMemEval 100%** — 在別人的球場打球。85%+ 夠用。
- **做成 agent** — 永遠是 plugin/infrastructure。
- **加 API key 依賴** — 零依賴是 moat 之一。
- **做 managed cloud 版** — Mem0 的路線，我們走本地優先。

---

## Codex 可以直接跑的 (v0.4 一起 ship)

1. ✅ Memory Architecture v2 (8 tasks, 正在跑)
2. Decision Replay 獨立 benchmark package
3. brain_quiz 擴充 + share 功能
4. Memory Diff CLI + MCP tool

## 之後再做

5. Brain Profile (v0.5)
6. Decision Pattern Intelligence (v1.0+)
