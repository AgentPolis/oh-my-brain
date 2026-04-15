# Plan: LLM Event Extraction — 用大模型抽事件

> 單獨 task。可以併入 v0.7 或獨立跑。
>
> Context: oh-my-brain v0.6.1。event-extractor.ts 目前是純 regex。
> LongMemEval 88% (44/50)，其中 1 題因為 regex 漏抓而答錯。
>
> 2026 年了，用戶手上有大模型。regex 猜句型是上個時代的做法。

---

## 設計原則

**LLM first, regex fallback。不是反過來。**

```
有 API key（絕大多數用戶）:
  → LLM 抽事件。精準、不漏、理解語意。

沒 API key（離線 / 特殊場景）:
  → regex 抽事件。有比沒有好。現有行為不 break。
```

用戶已經登入 Claude Code 或 Codex 了。oh-my-brain 直接用
`claude -p` 或 `codex exec` 來 call LLM — 走用戶已經登入的
session，不需要額外設 API key。就像 oh-my-brain eval 和
brain_quiz 的做法一樣。

偵測順序：
1. `claude -p` 可用 → 用 Claude（因為 oh-my-brain 本身就跑在 Claude Code 裡）
2. `codex exec` 可用 → 用 Codex
3. 都不可用 → regex fallback（離線場景）

注意：在 Claude Code session 內部不能套娃呼叫 `claude -p`。
所以 compress hook（作為 Stop hook 觸發）實際上是在 session
結束後跑的，此時可以安全呼叫 `claude -p`。如果不行，用
`codex exec` 作為 fallback。

---

## Task: LLM Event Extraction

**File:** `cli/event-extractor.ts`

### What to do

改 `extractEvents()` 的邏輯：

```typescript
export async function extractEvents(
  messages: Array<{ role: string; content: string }>,
  context: {
    sessionId: string;
    sessionDate: string;
  }
): Promise<BrainEvent[]> {
  // 1. 偵測是否有 API key
  const apiKey = process.env.ANTHROPIC_API_KEY
    || process.env.OPENAI_API_KEY
    || null;

  // 偵測可用的 LLM CLI
  const llmCli = await detectLLMCli(); // "claude" | "codex" | null

  if (llmCli) {
    // LLM extraction — 精準，走用戶已登入的 session
    return extractEventsWithLLM(messages, context, llmCli);
  } else {
    // regex fallback — 離線可用
    return extractEventsWithRegex(messages, context);
  }
}
```

**LLM extraction 實作：**

```typescript
async function extractEventsWithLLM(
  messages: Array<{ role: string; content: string }>,
  context: { sessionId: string; sessionDate: string },
  apiKey: string
): Promise<BrainEvent[]> {
  // 只取 user messages
  const userTexts = messages
    .filter(m => m.role === "user")
    .map(m => m.content)
    .join("\n---\n");

  if (!userTexts.trim()) return [];

  const prompt = `Extract structured events from these conversation messages.

Rules:
- Only extract things that HAPPENED (past tense). Skip intentions, questions, opinions.
- Each event must have: what (one phrase), when (date or relative time), category
- Optional: who (people involved), where (location), sentiment, detail
- Categories: vehicle, travel, shopping, work, health, social, entertainment, events, pets, other
- Return a JSON array. If no events found, return []

Messages:
${userTexts.slice(0, 15000)}

Respond with ONLY a JSON array, no explanation:`;

  try {
    let response: string;

    if (process.env.ANTHROPIC_API_KEY) {
      // Use Anthropic Haiku (cheapest, fastest)
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      response = data.content?.[0]?.text ?? "[]";
    } else if (process.env.OPENAI_API_KEY) {
      // Use OpenAI GPT-4o-mini (cheapest, fastest)
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      response = data.choices?.[0]?.message?.content ?? "[]";
    } else {
      return [];
    }

    // Parse the JSON response
    const raw = JSON.parse(
      response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
    );

    // Convert to BrainEvent[]
    return raw.map((e: any) => ({
      id: randomUUID(),
      ts: resolveDate(e.when, context.sessionDate),
      ts_ingest: new Date().toISOString(),
      ts_precision: e.when_precision || "relative",
      what: e.what || "",
      detail: e.detail || "",
      category: e.category || "other",
      who: Array.isArray(e.who) ? e.who : e.who ? [e.who] : [],
      where: e.where || "",
      related_to: [],
      sentiment: e.sentiment || "",
      viewpoint: e.viewpoint || "",
      insight: e.insight || "",
      source_text: "", // LLM already extracted, no need to store full text
      session_id: context.sessionId,
      turn_index: 0,
    }));
  } catch (err) {
    // LLM failed — fall back to regex
    console.error("[brain] LLM extraction failed, falling back to regex:", err);
    return extractEventsWithRegex(
      messages.map(m => ({ role: m.role, content: m.content })),
      context
    );
  }
}
```

**現有的 regex extraction 重命名為 `extractEventsWithRegex`：**

把目前 `extractEvents()` 的全部 regex 邏輯搬到
`extractEventsWithRegex()`，不改不刪，原封不動。

**Compress hook 改動：**

`extractEvents()` 現在是 async。compress hook 已經有 async 的
流程，只需要加 await：

```typescript
// Before:
const events = extractEvents(msg, context);

// After:
const events = await extractEvents(messages, context);
```

注意：LLM extraction 是一次 call 處理所有 messages，不是逐條。
所以函數簽名從 `(single message)` 改成 `(messages array)`。

### 成本計算

```
一個 session ~20 條 user messages × ~50 tokens = ~1000 tokens input
Haiku: $0.25 / 1M input tokens → $0.00025 per session
一天 10 sessions → $0.0025
一個月 → $0.075（約 2 塊台幣）
```

### Acceptance criteria

- 有 ANTHROPIC_API_KEY → 用 Haiku 抽事件
- 有 OPENAI_API_KEY → 用 GPT-4o-mini 抽事件
- 沒有任何 key → regex fallback（現有行為不變）
- LLM 失敗（timeout、parse error）→ 自動 fallback 到 regex
- 一個 session 只 call 一次 LLM（打包所有 user messages）
- 回傳的 BrainEvent[] 格式跟 regex 版完全相同
- 不加任何新 npm dependency（用 Node.js 內建 fetch）
- New test: mock LLM response, verify event parsing
- New test: verify regex fallback when no API key

### Gotchas

- **不加 anthropic 或 openai SDK dependency。** 用 Node.js 內建
  的 `fetch()` 直接 call REST API。零新依賴。
- **LLM 回傳的 JSON 可能不乾淨。** 要 strip markdown code fences
  (```json ... ```) 和多餘文字。
- **Prompt 限制 15000 chars。** 太長的 session 截斷。
- **不改 extractEventsWithRegex。** 它是 fallback，不能壞。
- **source_text 在 LLM mode 可以留空。** LLM 已經做了 extraction，
  不需要存原文（archive 有原文）。
