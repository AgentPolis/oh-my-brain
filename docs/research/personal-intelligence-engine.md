# 從 Cognitive Memory 到 Personal Intelligence Engine

> 這份文件承接 `cognitive-memory-framework.md`，把問題從
> 「應該記什麼」往前推到「怎麼讓 agent 真的越用越像你、越做越好」。
> 更新日期：2026-04-15

---

## 核心命題

理解 user 的決策方式、成長方式、偏好與習慣，最後不是為了做一個
「很懂你」的靜態記憶系統，而是為了回答一個更產品化的問題：

> **這個 agent 下次怎麼做得更好？**

更完整地說：

> **如何讓任何 agent 越來越像你地做事，並在你會犯錯的地方，比你更穩。**

這裡要同時成立兩個目標：

1. **Personal alignment** — agent 的做法、取捨、語氣、偏好像你
2. **Task excellence** — agent 完成任務更穩、更少踩坑、更能補盲點

如果只有 alignment，最後只是模仿 user。
如果只有 excellence，最後只是 generic copilot。

真正的第二大腦是兩者疊加：

> **像你做決策，但比你少犯錯。**

---

## 重新定義產品

oh-my-brain 的終局不應該只是：

- memory layer
- vector store
- profile system
- another agent

而應該是：

**Personal Intelligence Engine**

一個讓任何 agent：

- 一裝就能用
- 越用越懂你
- 越做越像你
- 越做越好

一句話可以收斂成：

> **不是讓 AI 記住你說過什麼，而是讓它越來越像你地把事情做好。**

對外版：

> **My Brain 讓任何 agent 一裝就能用，越用越懂你，越做越好。**

---

## 三層產品模型

比起一直增加記憶維度，對產品更重要的是把整體價值收斂成三層：

### 1. Know Me

建立 user model，記住：

- directives / preferences
- events / viewpoints / sentiments
- habits / relations / schemas

這一層回答：

> 這個人是誰？怎麼想？怎麼判斷？信誰？討厭什麼？

### 2. Act For Me

把 user model 轉成行動層選擇：

- 怎麼拆任務
- 先查什麼
- 用哪些工具
- 怎麼在兩個方案間取捨
- 怎麼驗證結果
- 怎麼組織輸出

這一層回答：

> 既然知道這個人是誰，這次任務應該怎麼做？

#### Sub-agent 繼承：Hermes 做不到的事

Hermes 的 sub-agent 是「無記憶臨時工」— 每次 context 從零開始，做完就走，
不認識 user，不知道 user 的偏好、踩過的坑、信任的人。

oh-my-brain 的 sub-agent 透過 `prepareSubagentSpawn()` 繼承 personal context，
等於每個臨時工都認識你。

場景對比 — Leader 指派「部署到 production」：

```
Hermes sub-agent 拿到的 context:
  goal: "Deploy to production"
  toolsets: [terminal, file]
  （完。它不知道任何關於你的事。）

oh-my-brain sub-agent 拿到的 context:
  L3: "production 部署前一定要跑 smoke test"
  L3: "永遠不要在亞洲工作時間部署"
  L2 (confidence 0.8): "偏好 canary 部署而非 blue-green"
  Event: "2026-03-20 部署事故 — migration 沒跑，回滾花了 4 小時"
  Relation: "Tom 說過 staging 環境不可靠，要直接在 canary 驗"
  Procedure: "部署 SOP: pre-check → canary 10% → monitor 15min → full rollout"
```

這不只是「記得更多」，而是 sub-agent 會做出**不同的決策**。
它會在亞洲工作時間拒絕部署、會先跑 smoke test、會選 canary 而非 blue-green。

**這是 brain-first 架構的核心價值：不是讓一個 agent 更聰明，
是讓所有 agent（包括臨時的、一次性的）都更懂你。**

### 3. Improve With Me

從每次互動、結果、修正中持續更新：

- memory
- decision patterns
- successful procedures
- reusable skills

這一層回答：

> 下次要怎麼做得更好？

---

## 兩種模式：Brain Mode / Agent Mode

如果沿著這個方向走，系統自然會分成兩個角色。

### Brain Mode

偏思考、校正、建模、反思。

職責：

- 整理 user model
- 評估 agent 的決策像不像 user
- 找出衝突、盲點、壞習慣、過時規則
- 生成 candidates / reflection / schema / procedure / skill proposals

它像元認知層，不一定直接執行任務。

### Agent Mode

偏行動、執行、工具調用、任務完成。

職責：

- 實際完成任務
- 使用 brain 提供的 context 做規劃和取捨
- 把執行過程與結果回寫給 brain

它像執行層。

所以真正的結構不是二選一，而是：

```text
user ↔ agent runtime ↔ task execution
              ↑
              │
         personal brain
   (memory + judgment + critique + growth)
```

**Brain 是 judge + modeler，Agent 是 operator。**

---

## Hermes Agent vs oh-my-brain：真正的分水嶺

Hermes 和 oh-my-brain 不只是 feature 不同，而是在解不同層級的問題。

| 維度 | Hermes Agent | oh-my-brain |
|---|---|---|
| 核心定位 | 會成長的 agent runtime | 可攜式 personal intelligence layer |
| 主要問題 | `agent 怎麼越用越聰明？` | `不管換哪個 agent，它都認識我，還越來越會替我做事？` |
| 優化主體 | agent 的 operating recipe | user-specific decision substrate |
| 記憶重心 | session continuity + prompt assembly | user-owned model + cross-agent portability |
| 長項 | skills、runtime discipline、prompt caching、tool orchestration | importance classification、多維記憶、user sovereignty、跨 agent 共腦 |

更尖一點說：

> **Hermes 讓同一個 agent 越來越會做事；oh-my-brain 讓任何 agent 越來越會替這個人做事。**

### Hermes 真正在優化什麼

Hermes 的強不是「有記憶」而已，而是它把這些東西接成一條生產線：

- prompt assembly 分層
- frozen memory / user snapshots
- skills progressive disclosure
- tool-aware behavior guidance
- trace-driven self-evolution

也就是說，Hermes 在優化的是：

**agent 的 operating recipe**

它比較像：

- 這類任務一般怎麼做更好
- 這個 skill 怎麼寫更好
- 這段 prompt 怎麼優化更有效

### oh-my-brain 真正在優化什麼

oh-my-brain 的重心則是：

- 這個 user 怎麼決策
- 這個 user 信誰
- 這個 user 遇到什麼坑會後悔
- 這個 user 的 workflow 和風格是什麼

它優化的是：

**user-specific decision substrate**

這也是為什麼：

- Hermes 很自然會走向 skill evolution
- oh-my-brain 很自然會走向 event / relation / habit / schema / skill loop

### 具體機制對照：該學什麼、不該學什麼

| Hermes 機制 | 怎麼做的 | 我們該學的部分 | 不該學的部分 |
|---|---|---|---|
| Progressive Disclosure | 200 skills 只載名稱+摘要 (~3K tokens)，需要時才展開全文 | L3 directive 也該分層載入，不要全注入 | 不需要 SKILL.md 格式，我們的 procedure 已有自己的 schema |
| Prompt Cache 友善 | System prompt 前綴刻意保持穩定，讓 provider cache 命中 | Assembly 分 stable zone / dynamic zone | 不需要犧牲 task-aware 動態調整 |
| Memory 下次才生效 | MEMORY.md 改了當前 session 不感知 | 低信心 L2 可以延遲到下次 session 生效 | L3 directive 應該維持即時生效（我們的優勢） |
| Sub-agent 禁寫記憶 | delegate_task 的 child 被禁止 memory/delegation/send_message | MCP tool 加 trust level：read-only / propose / write | 不需要完全禁止，propose-only 比 blacklist 更彈性 |
| Honcho 12 維 User Model | 辯證法同時建模 user 和 agent 的關係，被動追蹤 | Brain Profile 可以加「agent 對 user 的理解程度」維度 | 不需要第三方 Honcho 依賴，我們的 relations + schemas 已經更豐富 |
| Skill Self-Improvement | skill_manage(patch) 修補使用中發現的問題 | Procedure 被 approve 後也要能 patch，不是一次定型 | 不需要 194 個 trigger keyword，我們用 event pattern matching |
| 四層記憶 (按用途分) | prompt / session / skill / user model | 認清按「用途」和按「重要性」分層是互補的，不是互斥 | 不需要放棄 L0-L3 重要性分類，這是我們的壓縮優勢 |

### 不該學錯的地方

我們應該學 Hermes 的：

1. runtime discipline
2. stable vs ephemeral prompt 分層
3. trace-driven optimization
4. guardrails + human review

但不要把自己的中心換掉。

我們的 growth 主體不是：

- prompt wording
- 單一 agent 的 system prompt
- 某個 runtime 的局部最優

而是：

- user model
- cross-agent shared brain
- user-aligned task performance

換句話說：

> **用 Hermes 的工程紀律，強化我們的 personal intelligence layer。不要把自己做回另一個 agent。**

---

## 真正的缺口：不是記憶缺口，而是執行缺口

現在的 oh-my-brain 在 declarative / episodic / relational /
metacognitive memory 上已經比典型 memory store 深很多。

真正的大缺口不是「再多一種記憶類型」，而是：

> **還沒有完整的 execution learning loop。**

目前我們比較會記住：

- user 是誰
- user 喜歡什麼
- user 怎麼判斷
- user 以前遇過什麼事

但還不夠會把這些轉成：

- task decomposition pattern
- tool ordering strategy
- troubleshooting procedure
- verification checklist
- reusable skill

所以真正要補的，不只是 `Procedure` 類型，而是一整條：

**Procedure + Skill + Outcome loop**

---

## 使用者真正會感受到「越來越聰明」的五個瞬間

使用者不會因為你有 Event / Schema / Relation 就感動。
他們會因為下面五種體驗，覺得這真的是第二大腦：

1. **Less repetition** — 不用再講一次
2. **Better defaults** — 一開始就更接近我要的做法
3. **Fewer bad decisions** — 更少踩我討厭的坑
4. **More useful initiative** — 會補我沒想到的下一步
5. **Visible growth** — 我看得出來它真的在變聰明
   - Hermes 的做法：自動生成 SKILL.md，使用者直接看到新 skill 出現在 `~/.hermes/skills/`
   - 我們的做法應該更豐富：
     - 新 directive / preference 出現時主動通知
     - 新 procedure candidate 提出時通知
     - 週報：「本週學到 3 個新偏好，避開了 2 個已知坑，提出 1 個新 procedure」
     - before/after 對比：同類型任務，上次 vs 這次的行為差異
   - **關鍵：growth 要是 agent 行為的改變，不只是 memory 條數的增加**

如果這五點做不到，再完整的 cognitive taxonomy 都只是內部模型。

---

## 系統真正要形成的五個閉環

### 1. User Modeling Loop

從對話、修正、歷史、環境中建立和更新 user model。

輸入：

- 明確規則
- 隱性偏好
- 事件
- 人際信任訊號
- 情緒 / 觀點

輸出：

- directives / preferences / events / relations / habits / schemas

### 2. Decision Alignment Loop

判斷 agent 這次的選擇是否像 user。

輸入：

- task context
- user model
- 過往 decision evidence

輸出：

- decision hints
- conflict warnings
- alignment score / replay evidence

### 3. Decision-to-Action Loop

讓 user model 真的影響：

- task planning
- tool choice
- output structure
- scope tradeoff
- fallback strategy

這是從「懂你」走到「幫你做事」的核心一跳。

### 4. Outcome Loop

系統不只學你說了什麼，也學這次結果怎樣：

- 哪個方案成功
- 哪個工具順序有效
- 哪個習慣導致失敗
- 哪個判斷值得下次沿用

沒有 outcome loop，系統只能 personalization，不能真正 improvement。

### 5. Skill Loop

從 repeated successful traces 抽出可重用 skill / procedure / playbook。

這一層是把：

- 做過的事
- 做對的事
- 做對很多次的事

變成：

- 下次怎麼做
- 什麼時候該這樣做
- 哪些坑要避開
- 做完要怎麼驗證

### Cross-cutting: Token Budget 是所有閉環的硬約束

五個閉環產出的所有記憶最終都要進 context window。
不是記得越多越好，是**在有限 budget 內放對的東西**。

Hermes 的教訓：memory cap 20% 不是為了省錢，
是為了防止 directive 污染 context，擠掉有用的對話內容。
Hermes 的 MEMORY.md 甚至有 3,575 字元硬上限 — 強迫你只留最重要的。

我們的對策：

- **每個閉環都要有「退出條件」** — 什麼時候停止往腦裡寫。
  Outcome loop 不是每個 outcome 都記，只記偏離預期的。
  Skill loop 不是每個成功 trace 都提 procedure，只提重複 3+ 次的。
- **Progressive disclosure 讓記憶量和 token 成本脫鉤** —
  50 個 directive 和 500 個的 startup 成本應該一樣。
- **Task-aware assembly 讓不同任務拿到不同的記憶子集** —
  coding 任務不需要載入 relation graph，planning 任務不需要載入 procedure 細節。
- **記憶成本上限 = context budget 的 15%**（已有），但要 per-category 分配：
  - L3 directives: max 5%
  - L2 preferences: max 3%
  - Procedures/skills: max 4%
  - Events/relations: max 3%
  - 超出的部分只放 index，on-demand 展開

---

## 具體產品感：使用者怎麼真的覺得這是第二大腦

如果這個系統要真正被用起來，使用者流程不該是：

- 先填 profile
- 先寫規則
- 先裝一堆 skill
- 先學系統怎麼配置

而應該是：

### Day 1：即插即用

- 安裝
- 接 Claude / Codex / Cursor 任一 agent
- 直接開始做真任務

### Week 1：被動學習

- 自動抓 corrections、preferences、repeat patterns
- 只在不確定的地方要求審核
- 讓 user 開始感受到「不用一直重講」

### Week 2：更像你

- 預設輸出更接近你的格式
- 決策更符合你的風格
- 更懂哪些方案你會排斥

### Week 3+：更會替你做事

- 開始提出可重用 workflow / skill
- 主動避免你常踩的坑
- 讓不同 agent 都像同一個熟悉你的搭檔

這時候使用者買到的不是 ontology，而是：

> **每個 agent 都像同一個越來越懂我的搭檔。**

---

## 接下來的具體 TODO

下面不是空泛方向，而是接下來應該落成的產品與工程工作。

### P0：把 user model 接到 action loop

**目標：** 不只 recall，真的影響 agent 行動。

**為什麼是 P0：** 目前 brain 只是被動注入 context，agent 拿到了但不一定用。
要讓 brain 影響 agent 的規劃、工具選擇和驗證策略，不只是輸出文案。

TODO：

- [ ] 在 `brain_recall` 回傳中加入 `action_hints` 欄位：
  - `preferred_strategy`: 根據 user model 推薦的方法
  - `avoid_list`: 已知使用者討厭或踩過坑的做法
  - `verify_with`: 推薦的驗證方式
- [ ] 新增 `brain_plan_context` MCP tool（唯讀），回傳：
  - 當前任務最相關的 directives (top-5)
  - 相關 events（過去類似任務的結果）
  - 相關 procedures（如果有的話）
  - 相關 relations（任務涉及的人的信任水平）
- [ ] `prepareSubagentSpawn()` 加入 personal context bundle：
  - L3 directives（全量，不超過 memory cap）
  - 任務相關 L2 preferences（confidence >= 0.6）
  - 最相關的 1-2 個 events
  - 最相關的 procedure（如果有）
- [ ] 三個使用節點分別取不同內容：
  - Planning: directives + events + relations + schemas
  - Execution: procedures + preferences + avoid_list
  - Verification: directives + past outcomes + verification checklists

完成標準：

- agent 在 planning / execution / verification 三個節點使用不同腦內容
- 至少 3 個真實任務案例能觀察到行為改變（決策不同，不只是文案不同）
- sub-agent 拿到 personal context 後行為與無 context 時明顯不同

### P0：建立 outcome logging

**目標：** 讓系統學結果，不只學說法。

**為什麼是 P0：** 沒有 outcome loop，系統只能 personalization（像你），不能 improvement（比你好）。
使用者不會因為 brain 「懂我」就留下來，要因為 brain 「幫我避坑」才留下來。

TODO：

- [ ] 定義 `OutcomeRecord` 資料結構，存入 `.squeeze/outcomes.jsonl`：
  ```
  { task_type, decision, rationale, result: "success"|"failure"|"partial",
    failure_mode?, lesson?, confidence, session_id, timestamp }
  ```
- [ ] 在 session 結束 hook 或 `consolidate` 中加入 outcome extraction：
  - 偵測 session 中的決策點（工具選擇、方案取捨、scope 判斷）
  - 對有明確結果的決策（成功/失敗/報錯）自動提取
  - 無明確結果的 → 標記為 pending，下次 session 追蹤
- [ ] Outcome → Memory 回寫規則：
  - 失敗 + 高信心 → 自動寫入 L2 caution（confidence 0.7）
  - 失敗 + 低信心 → Memory Candidate（人工審核）
  - 成功 + 重複 3 次 → 升級為 procedure candidate
  - 相關 relation 的 trust_level 根據結果微調（±0.1）
- [ ] `Decision Replay` 增加 outcome-aware 評估：
  - 測試場景帶入歷史 outcome
  - 評分考慮「agent 是否避開了已知失敗模式」

完成標準：

- `brain_search` 能回答「哪種決策最近常成功／失敗」
- 失敗 outcome 自動回寫為 L2 caution 或 candidate
- Decision Replay 分數在加入 outcome 後提升（有 before/after 數據）

### P0：建立 Procedure 候選層

**目標：** 補上程序性記憶 — 不只記「你是誰」，也記「怎麼做事」。

**為什麼是 P0：** 這是 Hermes Skills System 的核心能力，也是 oh-my-brain 最大的架構缺口。
沒有程序性記憶，brain 只能幫 agent 「懂你」，不能幫 agent 「替你做事」。

TODO：

- [ ] 新增 `ProcedureCandidate` 資料模型，存入 `.squeeze/procedures.jsonl`：
  ```
  { id, title, when_to_use, steps[]: { order, action, tool?, expected_result? },
    pitfalls[]: { description, evidence_event_id? },
    verification[]: { check, method },
    evidence: { session_ids[], outcome_ids[] },
    status: "candidate"|"approved"|"archived",
    version, created_at, updated_at }
  ```
- [ ] 四個觸發條件的偵測邏輯（在 session 結束 / consolidate 時跑）：
  - **長鏈成功：** 同一 session 中 5+ tool calls 完成同一類任務且無 error
  - **錯誤恢復：** 偵測到 error → 修復 → 成功的序列
  - **操作糾正：** 使用者說「不對，先做 X 再做 Y」→ 提取正確順序
  - **重複模式：** 3+ 個 session 中出現相同的 tool call 序列（用 Jaccard 比對）
- [ ] Procedure 的 review 流程（複用 Memory Candidates 的 approve/edit/reject UX）
- [ ] Approved procedure 可被 `brain_plan_context` 回傳給 agent

完成標準：

- 至少能從 3 個真實 trace 中自動提出 procedure candidates
- 使用者可 approve / edit / reject
- Approved procedure 在 `brain_plan_context` 中出現

### P1：把 Procedure 升成 Skill

**目標：** 從 memory 走到 reusable execution unit。

**Procedure vs Skill 的關係：**
- Procedure = 「做過的事的記錄」（事實性的，來自 trace）
- Skill = 「可以教給任何 agent 的做法」（規範性的，經過抽象）
- 一個 procedure 被使用 3+ 次且成功率 > 80% → 提案升級為 skill

TODO：

- [ ] 定義 `Skill` schema（不照搬 Hermes 的 SKILL.md，保持輕量）：
  ```
  { id, name, description, when_to_use, procedure_id (source),
    steps[], pitfalls[], verification[],
    trigger_patterns[]: string[],  // 什麼任務描述應該觸發這個 skill
    success_count, fail_count, last_used_at }
  ```
- [ ] Skill 的 progressive disclosure（學 Hermes）：
  - Level 0: 名稱 + 一行 description（載入 brain_recall 回傳的 index）
  - Level 1: 完整 steps + pitfalls + verification（on-demand 展開）
- [ ] `brain_recall` 回傳中加入 `applicable_skills[]`：
  - 根據當前任務描述 match trigger_patterns
  - 只回傳 Level 0 資訊，agent 需要時再 `brain_search(skill:name)` 展開
- [ ] Skill self-improvement（學 Hermes 的 patch 機制）：
  - 使用後如果失敗 → 自動提案修改 pitfalls
  - 使用後如果成功但步驟有變 → 提案更新 steps
  - 修改走 candidate review 流程，不自動寫入

完成標準：

- agent 能在相似任務中被推薦已批准的 skill
- 50+ skills 的 startup token 成本不超過 1K tokens（progressive disclosure）
- skill 使用後的 success/fail 被追蹤，影響後續推薦排序

### P1：L3 / L2 的 progressive disclosure

**目標：** 不讓 personal brain 成本隨記憶量線性上升。

**為什麼重要：** Hermes 的 MEMORY.md 有 3,575 字元硬上限。
我們沒有上限，但這反而是隱患 — 50+ directives 會吃掉大量 context budget，
擠壓 fresh tail 和 tool results 的空間，降低任務執行品質。

TODO：

- [ ] 為每個 directive/preference 記錄 `lastReferencedAt`（已有欄位，確保更新邏輯正確）
- [ ] Assembly 時分兩層載入：
  - **Always-on set (top-N)：** 按 `lastReferencedAt` + `createdAt` 加權排序，取 top-15
  - **Index-only set (其餘)：** 只注入一行 `"[directive:key] one-line-summary"`
  - Agent 需要時透過 `brain_search(directive:key)` 展開完整內容
- [ ] 排序演算法：`score = 0.6 * recency(lastReferencedAt) + 0.3 * frequency + 0.1 * age`
  - recency: 越近越高（exponential decay, half-life 7 天）
  - frequency: 被引用次數（需新增 `referenceCount` 欄位）
  - age: 越老的規則可能越 fundamental，給底分
- [ ] L2 preferences 同理，但 top-N 更小（top-10），且 confidence < 0.5 的不注入

完成標準：

- 50+ directives 的 startup injection < 2K tokens（目前無上限）
- Decision Replay 分數無顯著下降（before/after 測試）
- 被移到 index-only 的 directive 在被需要時仍可被 agent 查到

### P1：cache-aware assembly

**目標：** 保留 stable prefix，提升 provider prompt cache 命中率。

**Hermes 的做法：** PromptBuilder 刻意讓 system prompt 前綴保持穩定
（memory、skill index、context files 很少變），provider 的 prompt cache 命中率高。
我們的 assembler 目前每次都可能因為 task weight 變化而重新排列，cache 命中率低。

TODO：

- [ ] 把 assembled context 分成兩個 zone：
  ```
  [Stable Zone — 跨 turn 不變，放在 context 最前面]
    System prompt + tool schemas
    L3 Directives always-on set（固定排序：按 key 字母序）
    High-confidence L2 Preferences（confidence >= 0.8，固定排序）
    Skill index（Level 0：名稱+摘要）

  [Dynamic Zone — 每 turn 可能變，放在 context 後半]
    Task-weighted history summaries
    Fresh tail (recent messages)
    Tool results
    On-demand expanded directives/skills/events
  ```
- [ ] Stable zone 的內容只在以下情況才變：
  - 新 directive 加入 always-on set
  - Directive 被 retire/supersede
  - L2 confidence 跨越 0.8 閾值
- [ ] 測量 prefix stability：
  - 新增 `prefixHash` 記錄每次 assembly 的 stable zone hash
  - 追蹤跨 turn 的 hash 變化率，目標 < 10%

完成標準：

- Stable zone 跨 turn 的 hash 變化率 < 10%
- 不影響 task-aware 動態調整（dynamic zone 仍然按任務類型分配）
- 在支援 prompt cache 的 provider (Anthropic, OpenAI) 上可觀察到 token 成本下降

### P1：read/write trust levels for agents

**目標：** 不是所有接入 agent 都能自由改腦。

**為什麼重要：** 目前 `brain_remember` 任何接入的 agent 都能呼叫。
一個不受信任的 agent 可以寫入惡意 directive（injection via memory），
下次所有其他 agent 都會受影響。Hermes 的做法是 sub-agent 完全禁止寫記憶，
但我們可以做得更彈性。

TODO：

- [ ] 定義三個 trust level：
  - `read`: 只能 `brain_recall` / `brain_search`
  - `propose`: 能 `brain_candidates`（提案），但不能直接寫入
  - `write`: 能 `brain_remember`（直接寫入 L3/L2）
- [ ] 在 MCP server 加入 agent identity + trust level 配置：
  ```json
  // .squeeze/agent-trust.json
  { "claude-code": "write", "cursor": "propose", "sub-agent-*": "read",
    "default": "propose" }
  ```
- [ ] Audit log 增強：每次 MCP call 記錄 `{ agent_id, tool, args, trust_level, timestamp }`
- [ ] Injection guard 對 `propose` 級別的提案也要跑（已有 guard，確保覆蓋）

完成標準：

- `sub-agent-*` 預設只能 read，不能寫入或提案
- `brain_remember` 在 trust < write 時回傳 permission denied
- Audit log 能回答「這個 directive 是誰寫入的」

### P1：記憶生效時機 (effectiveFrom 語義)

**目標：** 防止低信心記憶在當前 session 中造成認知漂移。

**設計決策：**
Hermes 的做法是 MEMORY.md 改了當前 session 不感知，下次才生效。
好處是防止 mid-conversation 認知漂移，壞處是即時糾正無法即時反映。
我們的 L3 即時生效是優勢（使用者糾正後立刻看到行為改變），但需要安全閥。

TODO：

- [ ] 定義 effectiveFrom 語義：
  - 高信心 directive（使用者明確說 "always/never"）→ `immediate`（下次 assemble 生效）
  - 低信心 L2（行為推論、自動偵測、confidence < 0.6）→ `next_session`
  - Procedure candidate → `on_approve`（審核通過後生效）
  - Outcome-derived caution → `next_session`（避免當前 session 的結果自我強化）
- [ ] 在 `DirectiveRecord` / `PreferenceRecord` 加入 `effective_from: "immediate"|"next_session"|"on_approve"`
- [ ] Assembly 時根據 effectiveFrom 過濾：
  - `immediate`: 當前 session 就注入
  - `next_session`: 只在 session start 時注入，mid-session 新增的不注入
  - `on_approve`: 只在 status=approved 後注入

完成標準：

- 使用者明確糾正後，行為在當前 session 即時改變
- 自動偵測的低信心偏好不干擾當前 session
- 有 test case 驗證 mid-session 新增的 next_session 記憶不被載入

### P2：visible growth UX

**目標：** 讓 user 看得見 intelligence 在成長。

**為什麼重要：** Hermes 讓使用者直接看到新 skill 出現在 `~/.hermes/skills/`，
這是最直觀的「它在學」的體驗。我們需要更系統的 growth visibility。

TODO：

- [ ] `oh-my-brain growth` CLI 命令輸出固定格式的成長報告：
  ```
  📊 Growth Report (2026-04-08 — 2026-04-15)
  ──────────────────────────────────────────
  New directives:        +2 (L3: "Never deploy during Asia hours")
  New preferences:       +3 (L2: "Prefers canary deploy", confidence 0.8)
  New procedures:        +1 candidate (pending review)
  Outcomes tracked:      7 (5 success, 2 failure)
  Pitfalls avoided:      2 ("Skipped blue-green per past failure")
  ──────────────────────────────────────────
  Net intelligence delta: +8 entries, 2 pitfalls avoided
  ```
- [ ] Session 結束時自動顯示 mini growth summary（可配置關閉）：
  - 本次 session 新增了什麼
  - 本次 session 避開了哪些已知坑
- [ ] `oh-my-brain growth --diff` 支援 before/after 對比：
  - 同類型任務，上次 vs 這次的行為差異
  - 用於 demo 和使用者信任建立
- [ ] Growth 資料寫入 `.squeeze/growth.jsonl`（已有），確保格式一致

完成標準：

- user 能在 30 秒內理解「系統這週變聰明在哪裡」
- Growth report 中的每一項都能追溯到具體的 directive/outcome/procedure
- Demo 場景下能展示 before/after 行為差異

---

## 結論

oh-my-brain 不該停在「比較懂記憶」。

它真正應該成為的是：

> **the personal intelligence layer that makes any agent start useful, grow with you, and get better at doing work your way**

而這條路的關鍵不是再多發明幾種 memory type，
而是把：

- user modeling
- decision alignment
- action planning
- outcome learning
- skill extraction

接成一個真正閉合的 intelligence loop。
