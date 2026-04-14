# 認知記憶框架 — oh-my-brain 的下一步

> 從認知心理學出發，重新思考 AI agent 記憶應該記什麼、怎麼記。
> 研究日期：2026-04-14

---

## 人類記憶的完整分類

認知心理學把長期記憶分成兩大類：

```
長期記憶
├── 外顯記憶 (Explicit / Declarative) — 你知道你記得
│   ├── 語意記憶 (Semantic) — 事實和知識
│   │     "TypeScript 是 JavaScript 的超集"
│   │     "Mem0 的定價是 $19/mo"
│   │
│   └── 情節記憶 (Episodic) — 帶時空標記的事件
│         "2026-04-06 我重構了 MCP server，花了 3 小時"
│         "上次用 Heroku 部署出了問題，很挫折"
│
└── 內隱記憶 (Implicit / Non-declarative) — 你不知道你記得
    ├── 程序性記憶 (Procedural) — 技能和習慣
    │     總是先寫 test 再寫 code (TDD 習慣)
    │     code review 時第一眼看 error handling
    │     命名用 camelCase 不用想
    │
    ├── 促發效應 (Priming) — 過去經驗影響當下判斷
    │     上次被第三方服務坑過 → 傾向自建
    │     mentor 說過「安全不是 feature」→ 遇到安全問題會延期
    │
    └── 情緒記憶 (Emotional conditioning) — 感受影響偏好
          對 monorepo 有好感（因為上個專案用得很順）
          對 microservices 有壞感（因為除錯很痛苦）
```

Sources:
- [Episodic, Procedural and Semantic Memory](https://www.tutor2u.net/psychology/reference/episodic-procedural-and-semantic-memory)
- [Types of Memory](https://rotel.pressbooks.pub/biologicalpsychology/chapter/8-2-types-of-memory/)
- [Procedural Memory](https://thedecisionlab.com/reference-guide/psychology/procedural-memory)

---

## Kahneman 的雙系統決策

人做決策不是一個系統，是兩個：

```
System 1 (快思) — 直覺、自動、無意識
├── 基於習慣 (procedural memory)
├── 基於情緒 (emotional memory)
├── 基於促發 (priming from past experience)
└── 特徵：快、省力、容易出錯但通常夠好

System 2 (慢想) — 理性、刻意、有意識
├── 基於事實 (semantic memory)
├── 基於邏輯推理
├── 基於明確規則 (L3 directives!)
└── 特徵：慢、費力、準確但需要 context
```

**oh-my-brain 目前只記 System 2 的輸入**（L3 規則、L2 偏好）。
但人 70% 的決策是 System 1 做的。

Source: [Dual Process Theory](https://en.wikipedia.org/wiki/Dual_process_theory)

---

## Schema 理論 — 人不記細節，記框架

人腦不存原始資料。它存 **schema** — 用來理解和分類新資訊的框架。

> "Schemas are comprehensive representations in memory that provide
> a framework for interpreting new information."

例子：
- 你有一個「code review」的 schema：看完整性→看 error handling→
  看命名→看測試。你不需要每次「記住」這個流程，它是自動的。
- 你有一個「新技術評估」的 schema：看社群大小→看維護狀態→看
  breaking changes 歷史。

**Schema 就是 procedural memory 的認知版本。**

Source: [Schema Theory and Memory](https://www.psychologistworld.com/memory/schema-memory)

---

## 關係記憶 — 人不記孤立事實，記關係

> "Relational memory is the flexible ability to generalize across
> existing stores of information."

人腦不是 key-value store。它是 **graph**。每個記憶都跟其他記憶
有關聯。重要的不是「Tom 是工程師」（孤立事實），而是：
- Tom 推薦了 Redis → 你用了 Redis → Redis 很好用 → 你信任 Tom 的技術判斷
- 上次 Alice 的建議導致了一個 production bug → 你對 Alice 的建議會多驗證

**關係影響判斷。信任鏈影響決策。**

Source: [Relational Memory Theory](https://www.jneurosci.org/content/25/31/7254)

---

## 習慣 — 無意識的決策模式

習慣是 procedural memory 的特殊形式。你不知道你在做，但你每次都做。

程序員的習慣例子：
- 寫完 code 自動跑 lint（不用想）
- 變數名超過 20 字會覺得「太長了」（無意識的命名標準）
- 看到 `any` type 會不舒服（情緒反應 → 修改衝動）
- PR 超過 300 行會想拆（直覺閾值）

**這些從未被明確說出來，所以 oh-my-brain 永遠抓不到。**
它們不是 L3 ("always do X")，不是 L2 ("I prefer X")，
是 L_implicit — 從行為模式推論出的隱性規則。

Source: [Procedural Memory in Decision Making](https://www.simplypsychology.org/procedural-memory.html)

---

## 對 oh-my-brain 的啟示

### 現有 L0-L3 vs 認知心理學完整框架

```
oh-my-brain 現在          認知心理學          缺口
─────────────────────────────────────────────────────
L3 Directive              System 2 規則        ✅ 有
L2 Preference             System 2 偏好        ✅ 有
L1 Observation            語意記憶 (事實)      ⚠️ 有但沒結構化
—                         情節記憶 (事件+時空)  ❌ archive 有原文但沒抽事件
—                         程序性記憶 (習慣)     ❌ 完全沒有
—                         情緒記憶 (感受)       ❌ 完全沒有
—                         關係記憶 (信任鏈)     ❌ 完全沒有
—                         Schema (認知框架)     ❌ 完全沒有
—                         促發效應 (過去→現在)  ❌ 完全沒有
L0 Noise                  —                    ✅ 正確丟棄
```

### 從 L0-L3 到認知記憶架構

```
新的記憶分類（認知框架驅動）：

Explicit (外顯 — agent 可以直接引用):
  D  Directive    "Always use TypeScript strict mode"     ← 已有 L3
  P  Preference   "I prefer tabs"                         ← 已有 L2
  F  Fact         "Project uses ESM, vitest, tsup"        ← L1→結構化
  E  Event        "{when, what, who, where, outcome}"     ← L1→事件抽取
  V  Viewpoint    "我覺得 microservices 是過度工程"        ← NEW
  R  Relation     "{person, trust_level, context}"        ← NEW

Implicit (內隱 — 從行為推論):
  H  Habit        "總是先寫 test" (從 3+ 次行為推論)       ← NEW
  S  Sentiment    "對 Heroku 有負面感受" (從語氣推論)      ← NEW
  K  Schema       "code review 流程: error→naming→test"   ← NEW

Noise:
  X  Discard      "ok", "got it", empty tool output       ← 已有 L0
```

### 每種記憶類型如何影響決策

```
Decision: "要不要把 MCP server 拆成 microservices？"

D (Directive):  "Keep monolith until team > 3" → 不拆
P (Preference): "I prefer simple architecture" → 不拆
F (Fact):       "Team = 2 people" → 不拆
E (Event):      "上次拆微服務花了 3 週" → 不拆
V (Viewpoint):  "microservices 是過度工程" → 不拆
R (Relation):   "CTO 建議過不要拆" → 不拆 (信任 CTO)
H (Habit):      "總是先確認團隊規模再決定架構" → 檢查 team size
S (Sentiment):  "上次微服務 debug 很痛苦" → 強烈不拆
K (Schema):     "架構決策流程: team size→complexity→deadline" → 按框架走

結果: 9/9 指向不拆。高信心決策。
```

如果只有 D+P（目前的 oh-my-brain），答案也是「不拆」，
但信心低（只有 2 個信號）。完整框架有 9 個信號，信心高。

### 對 LongMemEval 的影響

LongMemEval 主要測 E (Event) 和 F (Fact)。
oh-my-brain 的弱項正好是 E — 事件記憶沒有結構化。

如果 oh-my-brain 能把「我上個月 14 號修了車，GPS 壞了」
轉成：

```json
{
  "type": "Event",
  "when": "2026-03-14",
  "what": "car service",
  "detail": "GPS malfunction discovered",
  "who": "mechanic Tom",
  "sentiment": "frustrated",
  "outcome": "GPS fixed next week"
}
```

那 temporal reasoning 題就能直接查 `when=2026-03-14` 拿到答案，
不需要掃全文。

### 對 Decision Replay 的影響

Decision Replay 主要測 D + V + H + S 的綜合。
目前只有 D (directives)。如果加上 V (viewpoints)、
H (habits from behavior)、S (sentiments)，
Decision Replay 分數會大幅提升 — 因為人的決策本來就不只是
靠明確規則，更多是靠直覺（System 1）。

---

## 實作路線圖

### Phase 1: Event Extraction (v0.5) — 提升 LongMemEval
- 把 L1 observation 轉成結構化 Event
- 每個 Event 有 {when, what, who, detail, outcome}
- brain_search 支援 Event query

### Phase 2: Viewpoint + Sentiment (v0.6) — 提升 Decision Replay
- 偵測「我覺得」「I think」「本質上」→ 存為 Viewpoint
- 偵測情緒語氣（挫折、開心、失望）→ 存為 Sentiment
- Decision Replay 用 V+S 作為額外 context

### Phase 3: Habit Detection (v0.7) — System 1 記憶
- 觀察使用者行為模式（3+ 次相同行為 → 推論為 Habit）
- 例：「使用者連續 5 次在寫 code 前先寫 test」→ Habit: TDD
- Habit 影響 agent 的預設行為

### Phase 4: Relation Graph (v0.8) — 社交認知
- 記錄人物之間的信任關係
- 「用戶總是接受 Alice 的 code review 建議」→ trust(Alice, high)
- 「用戶兩次否決了 Bob 的架構提案」→ trust(Bob, low, architecture)
- agent 遇到 Alice 和 Bob 矛盾的建議時，傾向 Alice

### Phase 5: Schema Detection (v1.0) — 認知框架
- 從 Habit + Event 序列推論出 Schema
- 例：使用者的「code review schema」是 error→naming→test→performance
- agent 做 code review 時自動按這個 schema 走

---

## 核心洞察

**記憶跟判斷不必然有直接關係，但要記得重要的事情，才能做好判斷。**

「重要的事情」不只是事實。包括：
1. **事件**（什麼時候發生了什麼）
2. **觀點**（你對事情的看法）
3. **關係**（你信任誰的判斷）
4. **感受**（過去經驗帶來的情緒）
5. **習慣**（你無意識的行為模式）
6. **框架**（你思考問題的結構）

oh-my-brain 的終極目標不是「記住所有東西」（那是資料庫），
而是「像你一樣理解世界」（那是認知模型）。

**Mem0 是資料庫。oh-my-brain 要成為認知模型。**
