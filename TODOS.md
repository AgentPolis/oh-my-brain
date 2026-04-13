# oh-my-brain — Plan & Checklist

> **Your personal world model that every AI agent grounds itself in.**
>
> v0.4.0 in progress. Archive-backed recall and temporal search are implemented.
> Pending: final publish prep and live post-release validation.
>
> Updated: 2026-04-14

---

## ✅ Shipped (v0.1 → v0.3)

### Phase 1: Credibility Pass (2026-04-06)
- [x] Dedup substring bug fixed (exact-line comparison via `parseExistingDirectives`)
- [x] Memory Candidates review queue (persistent store, CLI, soft-signal ingestion)
- [x] MEMORY.md write lock (cross-process lockfile with stale-lock stealing)
- [x] MEMORY.md supersession (`brain-candidates retire` + archive section)
- [x] L2 preference ingestion (classifier + engine wiring for explicit preferences)
- [x] L3 classifier false-positive fix (removed over-loose "should" / "太多" patterns)
- [x] TODOS.md + MVP blockers cleaned up
- [x] Pre-existing test failures fixed (better-sqlite3 ABI rebuild)

### Phase 2: Rename + MCP (2026-04-06)
- [x] Rename squeeze-claw → oh-my-brain (all code, all docs, all tests)
- [x] MCP server (brain-mcp, 9 tools over stdio JSON-RPC, zero new deps)
- [x] Cross-agent handoff demo (6-scenario integration test + docs/cross-agent-demo.md)
- [x] Umbrella CLI (`oh-my-brain` dispatches to all sub-commands)
- [x] Backward compat (SqueezeContextEngine / squeezeClawFactory aliases, legacy MEMORY.md heading parser)

### Phase 3: Launch Prep (2026-04-06)
- [x] README rewrite (new positioning, origin story, vs-Memorix table, honest benchmarks, FAQ)
- [x] Honest benchmark numbers (real session replay 30-82%, not synthetic 96.5%)
- [x] Memory-focused benchmarks (directive retention 100%, preference consistency 100%)
- [x] CHANGELOG v0.2.0 written

### Phase 4: Personal World Model (2026-04-08)
- [x] Repositioning essay (`docs/why-personal-world-model.md` — Palantir + Dorsey + self-growth)
- [x] README hero rewritten ("Your personal world model...")
- [x] Typed Actions + provenance + undo log (`cli/actions.ts`, 700 lines)
- [x] MCP tools: `brain_undo_last`, `brain_why`
- [x] L2 self-growth: Directive Types (`cli/types-store.ts`, 5 built-in types, auto-cluster proposal)
- [x] MCP tool: `brain_types` (list / classify / list_candidates / approve / reject)
- [x] L3 self-growth: Directive Links (`cli/links-store.ts`, 4 link kinds, pairwise detection)
- [x] MCP tool: `brain_links` (list / list_candidates / approve / reject)
- [x] Auto ontology scan on every directive write (hook AND MCP)
- [x] CHANGELOG v0.3.0 written

---

## 🚀 Phase 5: Ship (immediate — blocks everything else)

- [x] Hermes-style auto-learning + Decision Replay shipped

- [ ] **Empirical Stop hook verification**
  `cli/debug-hook.js` 已存在。需要你手動做一次：
  1. 在 `~/.claude/settings.json` 加 `"Stop": [{"hooks": [{"type": "command", "command": "node /abs/path/to/debug-hook.js"}]}]`
  2. 跑一次短的 Claude Code session
  3. 檢查 `/tmp/squeeze-debug-stdin.json`, `/tmp/squeeze-debug-env.json`, `/tmp/squeeze-debug-cwd.txt`
  4. 把觀察結果 commit 進 repo 鎖定假設

- [ ] **建立 GitHub repo**
  1. 在 GitHub web UI 建 `AgentPolis/oh-my-brain`
  2. `git remote add origin https://github.com/AgentPolis/oh-my-brain.git`
  3. `git push -u origin main`
  4. 舊的 `AgentPolis/squeeze-claw`（如果有的話）加 deprecation notice

- [ ] **npm publish**
  ```bash
  npm publish --access public
  ```
  確認 `oh-my-brain@0.4.0` 出現在 npmjs.com

- [ ] **搶 namespace（低成本高保護）**
  - 註冊 `ohmybrain.dev` domain（~$12/年）
  - PyPI: publish 一個空的 `oh-my-brain` placeholder（防止名字被搶）

---

## 📋 Phase 6: Early Traction (publish 後第 1-2 週)

- [ ] **寫 launch post**
  - HN 標題候選：「Show HN: oh-my-brain — your personal Palantir-style world model for AI agents」
  - 內容：濃縮 `docs/why-personal-world-model.md` 的核心（Palantir ontology + Dorsey world model + 個人版）
  - 附帶真實的 origin story（從 `docs/why-memory-candidates.md`）

- [ ] **在 Twitter/X 發 thread**
  - Hook: "every AI memory layer stores strings and treats them equally. we built one that knows which ones matter."
  - Thread 走 origin story → Memory Candidates → self-growing ontology → brain_why demo
  - 附帶 MCP smoke test 的 JSON-RPC 交互截圖

- [ ] **MCP marketplace 上架**
  - [mcp.directory](https://mcp.directory/)
  - [mcpmarket.com](https://mcpmarket.com/)
  - [glama.ai/mcp](https://glama.ai/mcp/)

- [ ] **Claude Code + Codex 社群分享**
  - GitHub Discussions / Discord 裡 demo cross-agent handoff 的流程
  - "How I made my Claude Code and Codex share the same brain"

- [ ] **收集 5 個早期使用者回饋**
  - 重點問：Memory Candidates 有沒有抓到你預期的東西？
  - 重點問：Directive Types 的分類有沒有幫到？還是 Uncategorized 太多？
  - 重點問：你真的用了 brain_why 嗎？

---

## 🔬 Phase 7: Product-Market Fit 驗證 (publish 後第 3-4 週)

- [ ] **Live telemetry**
  - 在 compress hook 裡加 opt-in 的匿名使用統計
  - 測量：sessions processed/day, directives written, candidates flagged vs approved ratio, types proposed vs approved ratio
  - 用 `.squeeze/telemetry.jsonl`，不送到雲端

- [ ] **真實 billing 影響測量**
  - 跟 2-3 個 early adopter 合作
  - 比較使用 oh-my-brain 前後的 Claude / Codex API billing
  - 記錄到 docs/real-billing-eval.md

- [ ] **Repetition-based L2 promotion**
  - 目前 L2 只抓明確偏好（"I prefer X"）
  - 需要 mention_counts schema migration（msg_id → normalized content key）
  - 這是使用者開始大量使用之後自然會碰到的缺口

- [ ] **LLM-backed classifier fallback**
  - 用 Haiku 處理 regex 分不開的模糊 case
  - 只在 confidence < 0.5 時觸發，不增加常規成本
  - Benchmark: 精準度提升多少 vs latency 增加多少

---

## 🏗️ Phase 8: Platform Expansion (publish 後第 2-3 個月)

- [ ] **agent-constitution integration**
  - L3 directives 餵給 agent-constitution 當治理規則
  - agent-constitution verdicts 寫回 MEMORY.md 當 L3 directive
  - 共用 Action log 做 cross-system provenance

- [ ] **PreToolUse hook**
  - 在 Claude Code session 開始時注入 L3 directives
  - 需要 Stop hook 驗證結果作為前提

- [ ] **Browser extension (Chrome/Arc)**
  - 捕捉使用者在 Notion / Linear / Slack 裡看到的重要資訊
  - 注入為 Memory Candidates，等使用者 approve
  - 第一步：content script 監聽 selection + right-click "send to brain"

- [ ] **macOS Accessibility API daemon**
  - 監聽使用者在不同 app 之間的視窗切換 + 選取文字
  - 最激進的 capture 模式：什麼都抓，全部進 Memory Candidates
  - 需要很小心的 privacy 設計

- [ ] **ohmybrain.dev landing page**
  - Trigger: 100 npm installs 或 50 GitHub stars
  - 內容：README hero + origin story + live demo GIF
  - 用 Astro 或 Next.js static export

- [ ] **Team collaboration**
  - 多人在同一個 project 裡共享 directive store
  - 需要 MEMORY.md 的 git merge 策略
  - 可能需要 conflict resolution UI

---

## 🎯 Traction Checkpoints

| 時間 | 指標 | Go/No-Go |
|------|------|----------|
| **7 天後** (2026-04-19) | npm installs > 20, GitHub stars > 10, 至少 1 個非你的用戶在用 | 如果 0 用戶：重新評估 launch channel |
| **14 天後** (2026-04-26) | npm installs > 100, 至少 3 個用戶回饋, 至少 1 個 MCP marketplace 上架 | 如果 < 50 installs：考慮換 launch 策略 |
| **30 天後** (2026-05-12) | npm installs > 500 或 GitHub stars > 100, 至少 1 個 non-trivial PR from community | 如果 < 200 installs：go/no-go 決定 — 繼續還是 pivot |

---

## 🔒 Known Design Decisions (resolved, don't relitigate)

- **JSONL format**: `{type, cwd, sessionId, message: {role, content}}`. Use `extractTextContent()` to normalize.
- **Session path**: `~/.claude/projects/$(pwd | tr '/' '-')/`.
- **Stale check**: position-only (index < total - 20).
- **MEMORY.md heading**: new writes use `## oh-my-brain directives (...)`; parser accepts both `oh-my-brain` and legacy `squeeze-claw` prefix.
- **Exit behavior**: always `exit 0`. Never crash a user's session.
- **ESM**: `"type": "module"`. CLI entries are separate tsup targets into `dist/cli/`.
- **Dedup**: exact-line comparison via `parseExistingDirectives`, NOT substring `includes()`.
- **Archive heading**: `## oh-my-brain archive (superseded directives — do not use)` — exact match matters.
- **Lockfile**: O_EXCL create with stale-lock stealing (30s age or dead pid). Falls back to unlocked write.
- **Action log**: append-only `.squeeze/actions.jsonl`. UndoAction doesn't delete the original; it appends a reversal.
- **Self-growth threshold**: Type clusters require 3+ uncategorized directives. Link detection uses Jaccard similarity ≥ 0.25.
- **Scope markers**: tightened in v0.3 — require longer phrases ("in typescript projects", "only when") to avoid "for" / "when" false positives.
- **.squeeze/ directory**: path preserved from v0.1 to avoid orphaning existing user data. Cosmetic only.
- **MCP transport**: newline-delimited JSON-RPC over stdio. No official SDK dependency. Can swap to @modelcontextprotocol/sdk later without changing tool shape.

---

## 📊 Current Numbers

| Metric | Value |
|--------|-------|
| Tests passing | 307 / 307 |
| Test files | 26 |
| Core modules | 13 CLI + 7 src |
| MCP tools | 9 |
| Built-in types | 5 |
| Link kinds | 4 |
| Action kinds | 9 (incl UndoAction) |
| Tarball size | 146 kB packed |
| Total files in package | 76 |
| Phase 4 new code | ~1600 lines |
| Commits since v0.1 | 17 |
