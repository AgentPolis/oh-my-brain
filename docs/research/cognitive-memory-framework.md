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
—                         關係記憶 (信任鏈)     ✅ 有
—                         Schema (認知框架)     ✅ 有
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

### LongMemEval 實測驗證（2026-04-14, 50 題 temporal-reasoning）

```
v0.3.1 raw dump (不用 oh-my-brain):     86% (43/50)
v0.3.1 real pipeline (L0-L3 + 壓縮):    74% (37/50)  ← 壓縮丟資訊
v0.4.0 real pipeline (+ archive 檢索):  72% (36/50)  ← archive 搜不到
```

答錯的 14 題分析：

| 類型 | 數量 | 例子 | 缺的記憶類型 |
|------|------|------|------------|
| 找不到 | 7 | "Samsung vs Dell 哪個先買？" — Dell 日期被壓縮丟了 | **Event** |
| 記錯細節 | 3 | "Rack Fest 前幾天？" — 答了「之後26天」，實際是「之前4天」 | **Event (精確時間)** |
| 漏算 | 3 | "參加了幾個慈善活動？" — 答3個，實際4個 | **Event (完整列表)** |
| parse error | 1 | codex output format | 工程問題 |

**所有答錯的題目都指向同一個缺口：Event（情節記憶）。**

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

**預估影響：** 7 題「找不到」+ 3 題「記錯」= +10 題。
36/50 → 46/50 = **92%**。超過 Hindsight (91.4%)。

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

---

## 神經可塑性 — 大腦不是靜態的

人腦最重要的特性不是容量，是**可塑性**（neuroplasticity）。
它不斷地：

```
探索 → 記憶 → 決策 → 結果 → 反思 → 修正認知 → 再探索
  ↑                                              │
  └──────────────── 永不停止的循環 ────────────────┘
```

這個循環有幾個關鍵特性：

1. **探索驅動學習** — 不是被動接收，是主動探索。
   agent 應該主動觀察（Memory Candidates），不只是等你說「remember」

2. **結果反饋修正認知** — 做了決策，看結果，修正規則。
   oh-my-brain 目前只存規則，不存結果。應該要：
   - 記住「我選了 Build in-house」（決策）
   - 記住「結果：省了 $19/mo 但多花了 2 週」（結果）
   - 下次碰到類似情境，用結果修正判斷

3. **反思產生更高層的認知** — 不只是記住事件，是從事件中
   抽取 pattern。
   - 事件：「我三次選了自建而不是外包」
   - 反思：「我是一個偏好自建的人」（meta-cognition）
   - 這就是 Brain Profile 的認知基礎

4. **修正是常態，不是例外** — 人腦隨時在 supersede 舊認知。
   oh-my-brain 的 directive supersession 機制是正確的方向，
   但應該更主動（自動偵測過時的 directive，不是等用戶手動 retire）

---

## 離線成長 — 人離開了，大腦還在

這是 oh-my-brain 最深的哲學定位。真正的第二大腦不是「你用的
時候才工作」的工具。它是一個持續運作的認知實體。

```
你在線時：
  agent 跟你互動 → 學習你的決策 → 記住你的偏好
  這是 active learning

你離線時（當前能力）：
  compress hook → 分類 + 壓縮 + 存 archive
  codex-sync    → 跨 agent 同步
  auto-consolidation → 合併重複 directive
  type/link growth → ontology 自動演化

你離線時（目標能力）：
  反思循環 — 定期掃描 directive 集合，發現矛盾、過時、缺口
  外部資訊接收 — 從 git log、PR、issue 等持續學習
  認知修正 — 自動提案修正過時的 directive（進 candidates queue）
  成長報告 — 你回來時看到「你離開期間，我學了 3 件事」
```

### 具體機制

**1. 反思循環 (Reflection Loop)**

```
定期（每天/每次 session 結束）：
  掃描所有 directive
  → 有沒有超過 30 天沒被引用的？→ 提案 retire
  → 有沒有互相矛盾的？→ 提案解決
  → 有沒有可以合併的？→ 提案 merge（已有 auto-consolidation）
  → 有沒有從 3+ 個 directive 可以抽取的 pattern？→ 提案新 schema
```

**2. 外部資訊接收**

```
大腦不只從對話學習，也從環境學習：
  git log → 「用戶最近在做什麼專案？」
  package.json changes → 「加了新 dependency，可能需要新 directive」
  PR comments → 「code review 裡的決策可以記住」
  .cursorrules changes → 「用戶手動改了規則，同步到 MEMORY.md」
```

**3. 睡眠整合 (Sleep Consolidation)**

人腦在睡眠時整合白天的記憶。oh-my-brain 的等價物：

```
brain-consolidate (定期 cron job)：
  1. 壓縮 archive（合併同主題的事件）
  2. 更新 timeline index
  3. 檢測 emerging patterns → 新 directive candidates
  4. 更新 Brain Profile（決策風格有沒有變）
  5. 清理過期的 L1 observations
  6. 寫一份「成長日誌」→ 下次 session 開始時顯示
```

這就是 MemPalace 宣稱的「dream cycle」但沒有實現的東西。
oh-my-brain 可以真正做出來。

---

## 終極定位

```
Mem0:        資料庫 — 存你說過的話
MemPalace:   檔案櫃 — 整理你的記憶
Hindsight:   搜索引擎 — 找到你的記憶
oh-my-brain: 認知模型 — 像你一樣理解世界

                          理解深度
                            ↑
                            │
          oh-my-brain ●     │     ← 認知模型
                            │        (記得+理解+判斷+成長)
                            │
          Hindsight   ●     │     ← 知識圖譜
                            │        (記得+關聯)
                            │
          MemPalace   ●     │     ← 結構化存儲
                            │        (記得+整理)
                            │
          Mem0        ●     │     ← 向量存儲
                            │        (記得)
                            │
                    ────────┼──────────→ 記憶量
```

**不是記得多少，是理解多深。**

---

## 從認知記憶到 Personal Intelligence Engine

這份文件前半段回答的是：

> **應該記什麼，才能更像人的認知結構？**

但真正的產品問題其實還要再往前一步：

> **知道 user 怎麼決策、怎麼成長，最後要怎麼讓 agent 下次做得更好？**

這一層已經延伸成獨立文件：

- [`personal-intelligence-engine.md`](personal-intelligence-engine.md)

那份文件補上了：

- 為什麼 oh-my-brain 不該只停在 memory layer
- 為什麼系統要分成 Brain Mode / Agent Mode
- Hermes Agent vs oh-my-brain 的更深層分水嶺
- 真正要形成的五個閉環：user modeling、decision alignment、decision-to-action、outcome、skill
- 接下來的具體產品 / 工程 TODO，不只停在定位討論

如果這份文件是在回答「記憶與認知結構」，那下一份就是回答：

> **怎麼把認知模型接成真正會成長、會做事的 personal intelligence engine。**
