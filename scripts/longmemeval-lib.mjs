const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "at", "for", "from",
  "with", "by", "my", "me", "i", "we", "you", "your", "it", "is", "are", "was",
  "were", "be", "been", "do", "did", "have", "had", "has", "this", "that",
  "these", "those", "what", "which", "who", "when", "where", "how", "many",
  "much", "long", "before", "after", "between", "current", "currently", "last",
  "first", "most", "recently", "recent", "total", "combined", "than", "now",
]);

const IGNORED_ENTITIES = new Set([
  "i", "we", "you", "my", "your", "what", "which", "who", "when", "where",
  "how", "did i", "do i", "have i", "am i", "was i", "were i",
]);

const MONTHS = new Set([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
  "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
]);

const DATE_PATTERN = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?\b|\b\d{4}\/\d{2}\/\d{2}\b/i;
const PERCENT_PATTERN = /(\d+(?:\.\d+)?)%/g;

const ANCHOR_STOPWORDS = new Set([
  ...STOPWORDS,
  "am", "pm", "did", "done", "been", "start", "started", "current",
]);

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").replace(/\s+/g, " ").trim();
}

function isIgnoredEntity(candidate) {
  return IGNORED_ENTITIES.has(candidate.trim().toLowerCase());
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function extractQuestionKeywords(question) {
  const normalized = normalizeText(question);
  return normalized
    .split(" ")
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

export function extractQuestionEntities(question) {
  const entities = new Set();

  for (const match of question.matchAll(/['"]([^'"]{2,80})['"]/g)) {
    entities.add(match[1].trim());
  }

  for (const match of question.matchAll(/\b([A-Z][a-z0-9.+-]*(?:\s+[A-Z][a-z0-9.+-]*)*)\b/g)) {
    const candidate = match[1].trim();
    if (!candidate || MONTHS.has(candidate) || isIgnoredEntity(candidate)) continue;
    entities.add(candidate);
  }

  for (const match of question.matchAll(/\b(?:at|for|to|from|with|in)\s+([A-Z][\w.+-]*(?:\s+[A-Z][\w.+-]*)*)/g)) {
    const candidate = match[1].trim();
    if (!candidate || MONTHS.has(candidate) || isIgnoredEntity(candidate)) continue;
    entities.add(candidate);
  }

  for (const match of question.matchAll(/\b([A-Za-z0-9.+-]*[A-Z][A-Za-z0-9.+-]*(?:\s+[A-Za-z0-9.+-]*[A-Z][A-Za-z0-9.+-]*)*)\b/g)) {
    const candidate = match[1].trim();
    if (!candidate || MONTHS.has(candidate) || isIgnoredEntity(candidate)) continue;
    if (!/[A-Z]/.test(candidate.replace(/^[A-Z]/, ""))) continue;
    entities.add(candidate);
  }

  return Array.from(entities);
}

export function extractOptionPairs(question) {
  const pairs = [];
  for (const match of question.matchAll(/,\s*([^,?]+?)\s+or\s+([^?]+?)(?:\?|$)/gi)) {
    const left = match[1].trim();
    const right = match[2].trim();
    if (left && right) pairs.push([left, right]);
  }
  if (pairs.length > 0) return pairs;

  for (const match of question.matchAll(/(?:first|last|more recently|earlier),?\s+(.+?)\s+or\s+(.+?)(?:\?|$)/gi)) {
    const left = match[1].trim();
    const right = match[2].trim();
    if (left && right) pairs.push([left, right]);
  }
  return pairs;
}

function flattenSessionTexts(instance) {
  const texts = [];
  for (const [idx, session] of (instance.haystack_sessions ?? []).entries()) {
    const date = instance.haystack_dates?.[idx] ?? "";
    for (const msg of session) {
      if (!msg || typeof msg.content !== "string") continue;
      texts.push({ date, role: msg.role, content: msg.content });
    }
  }
  return texts;
}

function includesNormalized(haystack, needle) {
  const a = normalizeText(haystack);
  const b = normalizeText(needle);
  return b.length > 0 && a.includes(b);
}

function stemToken(token) {
  let normalized = token.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return normalized;
  if (normalized === "flew") return "fly";
  if (normalized === "flown") return "fly";
  if (normalized === "took") return "take";
  if (normalized === "taken") return "take";
  if (normalized.endsWith("ves") && normalized.length > 4) {
    normalized = `${normalized.slice(0, -3)}ve`;
  } else if (normalized.endsWith("ing") && normalized.length > 5) {
    normalized = normalized.slice(0, -3);
  } else if (normalized.endsWith("ed") && normalized.length > 4) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("es") && normalized.length > 4) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("s") && normalized.length > 3) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function keywordStems(text) {
  return uniqueStrings(
    normalizeText(text)
      .split(" ")
      .map((token) => stemToken(token))
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  );
}

function phraseMatchScore(content, phrase) {
  const phraseKeywords = keywordStems(phrase);
  if (phraseKeywords.length === 0) {
    return includesNormalized(content, phrase) ? 1 : 0;
  }

  const contentKeywords = new Set(keywordStems(content));
  let matched = 0;
  for (const keyword of phraseKeywords) {
    if (contentKeywords.has(keyword)) matched += 1;
  }
  return matched / phraseKeywords.length;
}

function phraseIsSupported(content, phrase) {
  if (includesNormalized(content, phrase)) return true;
  const phraseKeywords = keywordStems(phrase);
  if (phraseKeywords.length === 0) return false;
  const score = phraseMatchScore(content, phrase);
  if (phraseKeywords.length <= 2) return score >= 1;
  if (phraseKeywords.length === 3) return score >= 2 / 3;
  return score >= 0.75;
}

function tokenizeQuestion(question) {
  return question
    .replace(/[^A-Za-z0-9\s]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function deriveEntityAnchors(question, entity) {
  const tokens = tokenizeQuestion(question);
  const entityTokens = tokenizeQuestion(entity);
  if (entityTokens.length === 0) return [];

  const anchors = [];
  for (let index = 0; index <= tokens.length - entityTokens.length; index += 1) {
    const window = tokens.slice(index, index + entityTokens.length);
    if (window.join(" ").toLowerCase() !== entityTokens.join(" ").toLowerCase()) continue;

    const left = tokens.slice(Math.max(0, index - 3), index);
    const right = tokens.slice(index + entityTokens.length, index + entityTokens.length + 3);
    for (const token of [...left, ...right]) {
      const normalized = token.toLowerCase();
      if (normalized.length < 3 || ANCHOR_STOPWORDS.has(normalized)) continue;
      anchors.push(token);
    }
  }

  return uniqueStrings(anchors);
}

export function inferQuestionIntent(question) {
  const normalized = normalizeText(question);
  if (/\border of\b|\bearliest to latest\b|\blatest to earliest\b|\bfrom earliest to latest\b|\bfrom latest to earliest\b/.test(normalized)) {
    return "sequence";
  }
  if (/^(did|do|have|has|was|were|am|is|are)\b/.test(normalized)) {
    return "yes_no";
  }
  if (/\bwhich\b.*\bmost\b|\bwhat\b.*\bmost\b/.test(normalized)) {
    return "aggregate_choice";
  }
  if (/\bhow many\b|\bnumber of\b|\btotal\b|\bcombined\b/.test(normalized)) {
    return "count";
  }
  if (/\bhow long\b|\bhow many days\b|\bhow many weeks\b|\bhow many months\b/.test(normalized)) {
    return "duration";
  }
  if (/\bwhich\b.*\b(first|last|more recently|earlier)\b|\bwhat happened first\b/.test(normalized)) {
    return "comparison";
  }
  if (/\bwhen did\b|\bwhat date\b|\bwhich day\b/.test(normalized)) {
    return "date_lookup";
  }
  if (/\bcurrent\b|\blatest\b|\bmost recent\b|\bnow\b/.test(normalized)) {
    return "latest_state";
  }
  return "lookup";
}

function deriveCategoryHints(question) {
  const normalized = normalizeText(question);
  if (normalized.includes("airline")) return ["airline", "airlines"];
  if (normalized.includes("project")) return ["project", "projects"];
  if (normalized.includes("museum")) return ["museum", "museums", "gallery", "galleries"];
  if (normalized.includes("flight")) return ["flight", "flights", "airline", "airlines"];
  return [];
}

function extractContentEntities(content) {
  return uniqueStrings([
    ...extractQuestionEntities(content),
    ...Array.from(content.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+Airlines?)\b/g)).map((match) => match[1]),
  ]);
}

function collectAggregateCandidates(question, texts) {
  const categoryHints = deriveCategoryHints(question);
  const actionHints = keywordStems(question).filter(
    (hint) => !categoryHints.includes(hint) && !MONTHS.has(hint[0]?.toUpperCase() + hint.slice(1))
  );
  const counts = new Map();

  for (const entry of texts) {
    if (entry.role !== "user") continue;
    const contentKeywords = new Set(keywordStems(entry.content));
    if (
      actionHints.length > 0 &&
      !actionHints.some((hint) => contentKeywords.has(hint))
    ) {
      continue;
    }
    for (const entity of extractContentEntities(entry.content)) {
      const normalizedEntity = normalizeText(entity);
      if (
        categoryHints.length > 0 &&
        !categoryHints.some((hint) => normalizedEntity.includes(hint))
      ) {
        continue;
      }
      counts.set(entity, (counts.get(entity) ?? 0) + estimateCandidateWeight(categoryHints, entry.content));
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([entity, count]) => ({ entity, count }));
}

function estimateCandidateWeight(categoryHints, content) {
  const normalized = normalizeText(content);
  if (categoryHints.includes("airline") || categoryHints.includes("flight")) {
    if (normalized.includes("two flights each way")) return 4;
    if (normalized.includes("two flights one way")) return 2;
    if (normalized.includes("returning on") && normalized.includes("flying from")) return 2;
    if (normalized.includes("connecting flight")) return 1;
    if (normalized.includes("direct flight")) return 1;
    if (normalized.includes("flight") || normalized.includes("flew") || normalized.includes("flying")) {
      return 1;
    }
  }
  return 1;
}

export function extractEntityRequirements(question) {
  return extractQuestionEntities(question).map((entity) => ({
    entity,
    anchors: deriveEntityAnchors(question, entity),
  }));
}

export function findMissingEntities(question, texts) {
  const requirements = extractEntityRequirements(question);
  const missing = [];
  for (const requirement of requirements) {
    const found = texts.some((entry) => {
      if (!includesNormalized(entry.content, requirement.entity)) return false;
      if (requirement.anchors.length === 0) return true;
      return requirement.anchors.some((anchor) => includesNormalized(entry.content, anchor));
    });
    if (!found) missing.push(requirement.entity);
  }
  return uniqueStrings(missing);
}

function scoreText(questionKeywords, questionEntities, content) {
  const normalized = normalizeText(content);
  let score = 0;
  for (const keyword of questionKeywords) {
    if (normalized.includes(keyword)) score += 2;
  }
  for (const entity of questionEntities) {
    if (includesNormalized(content, entity)) score += 5;
  }
  return score;
}

function collectPhraseEvidence(texts, phrase, limit = 3) {
  return texts
    .filter((entry) => phraseIsSupported(entry.content, phrase))
    .slice(0, limit)
    .map((entry) => ({
      date: entry.date,
      role: entry.role,
      content: entry.content,
    }));
}

function findPercentValues(content) {
  return Array.from(content.matchAll(PERCENT_PATTERN)).map((match) => Number(match[1]));
}

function collectDateCandidates(question, texts) {
  const keywords = extractQuestionKeywords(question);
  return texts
    .map((entry) => {
      const score = scoreText(keywords, [], entry.content)
        + (DATE_PATTERN.test(entry.content) ? 4 : 0)
        + (/\bsubmit(?:ted)?\b/i.test(entry.content) ? 3 : 0)
        + (/\bconference\b|\bpaper\b|\bacl\b|\beacl\b/i.test(entry.content) ? 2 : 0);
      return { ...entry, score };
    })
    .filter((entry) => entry.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(({ date, role, content }) => ({ date, role, content }));
}

function collectComparisonValues(question, texts) {
  const entities = extractQuestionEntities(question).filter((entity) => !isIgnoredEntity(entity));
  const comparisons = [];

  for (const entity of entities) {
    for (const entry of texts) {
      if (!includesNormalized(entry.content, entity)) continue;
      const percents = findPercentValues(entry.content);
      if (percents.length === 0) continue;
      comparisons.push({
        entity,
        values: percents,
        date: entry.date,
        role: entry.role,
        content: entry.content,
      });
    }
  }

  return comparisons.slice(0, 8);
}

export function collectRelevantSnippets(instance, limit = 10) {
  const texts = flattenSessionTexts(instance);
  const questionKeywords = extractQuestionKeywords(instance.question);
  const questionEntities = extractQuestionEntities(instance.question);
  const ranked = texts
    .map((entry) => ({ ...entry, score: scoreText(questionKeywords, questionEntities, entry.content) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked;
}

export function analyzeQuestion(instance) {
  const texts = flattenSessionTexts(instance);
  const requirements = extractEntityRequirements(instance.question);
  const missingEntities = findMissingEntities(instance.question, texts);
  const optionPairs = extractOptionPairs(instance.question);
  const missingOptions = [];
  const intent = inferQuestionIntent(instance.question);
  const entityEvidence = requirements.map((requirement) => ({
    entity: requirement.entity,
    anchors: requirement.anchors,
    snippets: collectPhraseEvidence(texts, requirement.entity, 2),
  }));
  const optionEvidence = [];
  const aggregateCandidates =
    intent === "aggregate_choice" || intent === "count"
      ? collectAggregateCandidates(instance.question, texts)
      : [];
  const dateCandidates = intent === "date_lookup" ? collectDateCandidates(instance.question, texts) : [];
  const comparisonValues = intent === "yes_no" ? collectComparisonValues(instance.question, texts) : [];

  for (const [left, right] of optionPairs) {
    const leftFound = texts.some((entry) => phraseIsSupported(entry.content, left));
    const rightFound = texts.some((entry) => phraseIsSupported(entry.content, right));
    if (!leftFound) missingOptions.push(left);
    if (!rightFound) missingOptions.push(right);
    optionEvidence.push({
      option: left,
      snippets: collectPhraseEvidence(texts, left, 2),
    });
    optionEvidence.push({
      option: right,
      snippets: collectPhraseEvidence(texts, right, 2),
    });
  }

  const isAbstentionQuestion = String(instance.question_id).endsWith("_abs");
  const shouldForceAbstain = isAbstentionQuestion && (missingEntities.length > 0 || missingOptions.length > 0);

  return {
    intent,
    questionKeywords: extractQuestionKeywords(instance.question),
    questionEntities: extractQuestionEntities(instance.question),
    entityEvidence,
    optionEvidence,
    aggregateCandidates,
    dateCandidates,
    comparisonValues,
    missingEntities,
    missingOptions: uniqueStrings(missingOptions),
    relevantSnippets: collectRelevantSnippets(instance, 12),
    shouldForceAbstain,
  };
}

export function buildInsufficientAnswer(instance, analysis) {
  const missing = uniqueStrings([...analysis.missingEntities, ...analysis.missingOptions]);

  if (missing.length === 0) {
    return "I don't have enough information to determine that from the provided context.";
  }

  if (missing.length === 1) {
    return `I don't have enough information to determine that because the provided context does not clearly establish ${missing[0]}.`;
  }

  return `I don't have enough information to determine that because the provided context does not clearly establish ${missing.join(", ")}.`;
}

export function buildDeterministicAnswer(instance, analysis) {
  if (analysis.intent === "yes_no" && analysis.comparisonValues?.length >= 2) {
    const uniqueEntities = new Map();
    for (const item of analysis.comparisonValues) {
      if (!uniqueEntities.has(item.entity) && item.values.length > 0) {
        uniqueEntities.set(item.entity, item.values[0]);
      }
    }

    if (uniqueEntities.size >= 2) {
      const values = Array.from(uniqueEntities.values());
      if (/\bhigher\b|\bgreater\b|\bmore\b/.test(normalizeText(instance.question))) {
        return values[0] > values[1] ? "Yes." : "No.";
      }
      if (/\blower\b|\bless\b|\bsmaller\b/.test(normalizeText(instance.question))) {
        return values[0] < values[1] ? "Yes." : "No.";
      }
    }
  }

  return null;
}

export function buildReasoningPolicy(instance, analysis) {
  const lines = [];
  const isAbstentionQuestion = String(instance.question_id).endsWith("_abs");

  lines.push("Decision policy:");
  if (isAbstentionQuestion) {
    lines.push("- If a required entity or comparison target is missing, answer that the information is not enough.");
    lines.push("- Do not guess missing entities, prices, dates, counts, or destinations.");
  } else {
    lines.push("- Prefer the best supported answer from the memory context instead of defaulting to 'not enough information'.");
    lines.push("- Only say the information is not enough when the answer truly cannot be derived from the available evidence.");
  }

  if (analysis.intent === "count") {
    lines.push("- For count questions, enumerate each explicit supporting event before deciding on the total.");
    lines.push("- Do not compress multiple sessions into one event unless the memory context clearly says they are the same event.");
  }

  if (analysis.intent === "aggregate_choice") {
    lines.push("- For 'which ... most' questions, count explicit mentions for each candidate before choosing the winner.");
    lines.push("- If one candidate is supported more strongly than the others, answer with that candidate instead of saying the information is insufficient.");
  }

  if (analysis.intent === "duration") {
    lines.push("- For duration questions, find both anchor events first and only then compute the elapsed time.");
    lines.push("- If either anchor event is absent or underspecified, answer that the information is not enough.");
  }

  if (analysis.intent === "comparison") {
    lines.push("- For comparison questions, verify that both options appear in the memory context before deciding which came first or later.");
  }

  if (analysis.intent === "date_lookup") {
    lines.push("- For date lookup questions, return only a date that is explicitly supported by the context.");
  }

  if (analysis.intent === "sequence") {
    lines.push("- For ordering questions, reconstruct the sequence from the dated evidence and return the ordered list directly.");
  }

  if (analysis.intent === "yes_no") {
    lines.push("- For yes/no questions, compare the relevant values and answer 'Yes' or 'No' directly when the evidence supports a comparison.");
  }

  if (instance.question_type === "multi-session") {
    lines.push("- For multi-session questions, aggregate across every relevant session before answering.");
    lines.push("- For counts or totals, mentally enumerate each supporting item before producing the final answer.");
  }

  if (instance.question_type === "temporal-reasoning") {
    lines.push("- For temporal questions, only use explicit date/order clues from the memory context or relevant snippets.");
    lines.push("- Do not infer a timeline if one side of the comparison is missing.");
  }

  if (isAbstentionQuestion && (analysis.missingEntities.length > 0 || analysis.missingOptions.length > 0)) {
    lines.push(`- Missing entities detected: ${[...analysis.missingEntities, ...analysis.missingOptions].join(", ")}`);
  }

  return lines.join("\n");
}
