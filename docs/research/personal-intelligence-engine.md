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

## 接下來要做的事：4 個 Killing Features

使用者買的是這句話：

> **每個 agent 都像同一個越來越懂我的搭檔。**

使用者**感受得到**的只有五件事：

1. **不用重講** → 已有（L3/L2）
2. **預設就接近我要的** → 需要 action loop
3. **幫我避坑** → 需要 outcome
4. **記得怎麼做事** → 需要 procedure
5. **看得出它在變聰明** → 需要 growth 通知

其他的（progressive disclosure、cache-aware assembly、trust levels、effectiveFrom）
都是內部工程品質或規模化後的優化。**使用者不會因為你的 token 成本低 10% 而留下來。**

Day 1 只做三件事：**記結果、記流程、帶腦給 sub-agent**。
加一句話 growth 通知。其他等有用戶量再做。

---

### Kill 1：Outcome Loop — 「它幫我避坑」

**使用者的 aha moment：**

> 「上次我選了 blue-green deploy 結果出事，
> 這次它主動建議 canary 並且說明原因。」

**為什麼是殺手級：** 所有 memory 產品都沒做這件事。
Mem0 記事實，Hermes 記技能，**沒有人記結果**。
這是從 personalization（像你）跳到 improvement（比你好）的關鍵一步。

**最小可行範圍：只記失敗。** 成功太多太雜，失敗才有教訓。

TODO：

- [ ] 定義 `OutcomeRecord`，存入 `.squeeze/outcomes.jsonl`：
  ```
  { task_type, decision, result: "failure",
    failure_mode, lesson, session_id, timestamp }
  ```
  v1 只存 failure。成功以後再加。
- [ ] 在 session 結束 hook 中偵測失敗：
  - 明確的 error / rollback / 使用者說「不對」「壞了」「搞砸了」
  - 用 regex 快速偵測，不需要 LLM 分類（保持零成本）
- [ ] 失敗 → 自動寫入 L2 caution（confidence 0.7）：
  - key = `caution:{task_type}:{failure_mode}`
  - value = `"上次 {decision} 導致 {failure_mode}，考慮 {lesson}"`
  - 走 Memory Candidate 流程（使用者可以 reject）
- [ ] `brain_recall` 回傳中加入 `cautions[]`：
  - 當前任務相關的過去失敗
  - Agent 看到 caution 後自然會調整策略

完成標準：

- 一個真實失敗 → 自動出現在 candidates → approve 後 → 下次相似任務 brain_recall 帶出
- 端到端跑通一個完整的避坑案例

---

### Kill 2：Procedure — 「它記得我怎麼做事」

**使用者的 aha moment：**

> 「我沒教它部署流程，但它記得我上次的步驟，
> 還知道要先跑 smoke test。」

**為什麼是殺手級：** 這是 Hermes Skills System 的核心能力。
沒有程序性記憶，brain 只能幫 agent「懂你」，不能幫 agent「替你做事」。

**最小可行範圍：只做明確觸發。** 不做自動偵測（太複雜），
只做使用者說「記住這個流程」→ 從當前 session 提取。自動偵測以後再加。

TODO：

- [ ] 新增 `brain_save_procedure` MCP tool：
  ```
  brain_save_procedure({
    title: "Production deploy",
    trigger: "部署到 production"
  })
  ```
  Agent 呼叫後，從當前 session 的最近 N 個 tool calls 自動提取：
  - `steps[]`: 按順序列出執行的動作
  - `pitfalls[]`: 從 session 中的 error/retry 提取
  - `verification[]`: 從 session 最後的檢查步驟提取
- [ ] 存入 `.squeeze/procedures.jsonl`：
  ```
  { id, title, trigger, steps[], pitfalls[], verification[],
    status: "candidate"|"approved", source_session_id,
    created_at, updated_at }
  ```
- [ ] Procedure 走 Memory Candidate review 流程（approve/edit/reject）
- [ ] Approved procedure 在 `brain_recall` 中根據任務描述 match trigger 回傳

完成標準：

- 使用者做完一個多步驟任務 → 說「記住這個流程」→ procedure candidate 出現
- Approve 後，下次相似任務 brain_recall 回傳這個 procedure
- Procedure 包含 steps + pitfalls + verification

---

### Kill 3：Sub-agent 帶腦 — 「臨時工也認識我」

**使用者的 aha moment：**

> 「我讓 sub-agent 去部署，它自動避開了亞洲工作時間，
> 因為它知道我的規則。」

**為什麼是殺手級：** Hermes 和所有競品的 sub-agent 都是「無記憶臨時工」。
這是 brain-first 架構獨有的、結構性的差異化。

**最小可行範圍：只注入 L3 + 最相關的 1 個 procedure。**
不需要 events、relations、preferences。L3 夠用。

TODO：

- [ ] `prepareSubagentSpawn(taskDescription)` 組裝 personal context：
  - 全量 L3 directives（通常 < 20 條，< 1K tokens）
  - 根據 taskDescription match trigger 的 approved procedure（最多 1 個）
  - 相關 cautions（來自 outcome loop 的失敗教訓，最多 3 個）
  - 總計不超過 2K tokens
- [ ] 輸出格式：plain text block，可以直接拼進 sub-agent 的 system prompt：
  ```
  <personal-context>
  ## Rules (from user's brain)
  - Always run smoke test before production deploy
  - Never deploy during Asia business hours (UTC+8 09:00-18:00)

  ## Procedure: Production Deploy
  1. Run smoke test suite
  2. Deploy canary at 10%
  3. Monitor 15 minutes
  4. Full rollout

  ## Cautions
  - Last time blue-green deploy failed due to missing migration (2026-03-20)
  </personal-context>
  ```
- [ ] 在 ContextEngine interface 的 `prepareSubagentSpawn()` 實作
  （interface 已存在，需要補實作）

完成標準：

- Sub-agent 拿到 personal context 後，行為與無 context 時明顯不同
- 至少 1 個案例：sub-agent 因為帶了 L3 directive 而拒絕或調整了原本的做法
- Token overhead < 2K（不顯著增加 sub-agent 成本）

---

### +1：Growth 一句話 — 「它在學」

**使用者的 aha moment：**

> session 結束時看到：
> 「本次學到：你偏好 canary deploy（來自今天的部署決策）」

**為什麼要做：** 不需要完整的 growth report。
使用者只需要看到一句話，就知道系統在學。
Hermes 讓使用者看到新 skill 出現在目錄裡；我們用一句話達到同樣效果。

**最小可行範圍：一句話，不做 CLI、不做 report、不做 diff。**

TODO：

- [ ] Session 結束 hook 中，統計本次 session 新增了什麼：
  - 新 directive / preference 數量
  - 新 outcome 數量
  - 新 procedure candidate 數量
  - 因為已有 caution 而避開的坑（match brain_recall 的 cautions 被引用次數）
- [ ] 組成一句話 summary，注入 session 結束訊息：
  ```
  🧠 本次學到：+1 caution（blue-green deploy 風險），+1 procedure candidate（deploy SOP）
  ```
  如果本次什麼都沒學到，不顯示（避免噪音）。
- [ ] Growth 記錄寫入 `.squeeze/growth.jsonl`，供未來做 report 用
  （但 v1 不做 CLI report）

完成標準：

- Session 結束時，如果有學到東西，使用者看到一句話
- 沒學到東西時不顯示
- 一句話能追溯到具體的 directive/outcome/procedure

---

## Future — 等規模到了再做

以下不是不重要，而是在使用者量和記憶量到達臨界點之前不需要：

| 項目 | 觸發條件 | 說明 |
|------|---------|------|
| Procedure → Skill 升級 | 累積 20+ approved procedures | Procedure 本身就夠用，skill 是抽象化，等量到了再做 |
| L3/L2 progressive disclosure | 50+ directives | 50 條以下全注入 < 3K tokens，不是問題 |
| Cache-aware assembly | 觀察到 token 成本是瓶頸 | 純成本優化，不影響使用者體驗 |
| Agent trust levels | 多人使用 / 外部 agent 接入 | Day 1 只有你自己用，不需要 ACL |
| effectiveFrom 語義 | 出現 mid-session 認知漂移問題 | 目前即時生效是優勢，出問題再加安全閥 |
| 完整 growth report CLI | 有付費使用者要求 | 一句話夠用，完整 report 是 nice-to-have |

---

## 結論

oh-my-brain 不該停在「比較懂記憶」。

它真正應該成為的是：

> **the personal intelligence layer that makes any agent start useful, grow with you, and get better at doing work your way**

而這條路的 Day 1 不是再多發明幾種 memory type，而是：

1. **記結果** — 從失敗中學教訓（沒有競品在做）
2. **記流程** — 從操作中提取 procedure（Hermes 的核心能力，我們要有）
3. **帶腦給 sub-agent** — 臨時工也認識你（我們獨有的結構性差異化）
4. **一句話 growth** — 讓使用者知道它在學（信任的起點）

這四件事做完，使用者會感受到：

> **每個 agent 都像同一個越來越懂我、越來越會替我做事的搭檔。**
