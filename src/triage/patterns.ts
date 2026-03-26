/**
 * L0 regex fast-path classifier.
 * Catches common noise patterns with zero latency / zero cost.
 */

/** Ack patterns — single-word or very short responses that carry no information */
const ACK_PATTERNS = [
  /^(ok|okay|k|yes|no|yep|nope|sure|thanks|thank you|thx|ty|got it|understood|roger|cool|nice|great|perfect|done|noted|alright|right|fine|good|yea|yeah|yup|nah)\.?!?$/i,
  /^(👍|👌|✅|🙏|💯|✓|☑️|🎉|❤️|🫡)$/,
];

/** Patterns indicating the previous message asked a question or sought confirmation */
const QUESTION_PATTERNS = [
  /\?\s*$/,                                          // ends with ?
  /\b(should (we|I)|do you want|shall (we|I))\b/i,  // explicit asks
  /\b(would you like|want me to|proceed|confirm)\b/i,
  /\b(yes or no|y\/n|agree)\b/i,
  /\b(option [A-D]|choose|pick|select|which)\b/i,   // choice prompts
];

/** Empty or trivial tool results */
const EMPTY_RESULT_PATTERNS = [
  /^\s*$/,
  /^(no output|no results?|empty|none|null|undefined|N\/A)\.?\s*$/i,
  /^\(Bash completed with no output\)$/i,
  /^File created successfully/i,
  /^The file .+ has been updated successfully/i,
];

/** Repeated status checks that don't add information */
const STATUS_NOISE_PATTERNS = [
  /^(checking|loading|processing|working|thinking)\.{0,3}\s*$/i,
  /^(please wait|one moment|hold on|give me a sec)\.{0,3}\s*$/i,
];

/**
 * Try to classify a message as L0 via regex.
 * Returns true if the message is noise, false if it needs LLM classification.
 *
 * When previousContent is provided, acks that respond to a question or
 * confirmation prompt are NOT treated as noise — they carry meaning
 * from the context (e.g. "Should we delete prod?" → "yes").
 */
export function isL0Noise(content: string, previousContent?: string): boolean {
  const trimmed = content.trim();

  // Very short content is likely noise
  if (trimmed.length === 0) return true;

  // Check ack patterns — but only discard if the previous message
  // was NOT a question or confirmation prompt
  for (const pattern of ACK_PATTERNS) {
    if (pattern.test(trimmed)) {
      if (previousContent && isQuestionOrPrompt(previousContent)) {
        return false; // ack is a meaningful response to a question
      }
      return true;
    }
  }

  for (const pattern of EMPTY_RESULT_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  for (const pattern of STATUS_NOISE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/**
 * Check if content looks like a question or confirmation prompt.
 */
function isQuestionOrPrompt(content: string): boolean {
  return QUESTION_PATTERNS.some((p) => p.test(content));
}

/**
 * Quick heuristic for content type based on message content.
 * Used as a fast hint before LLM classification.
 */
export function hintContentType(
  role: string,
  content: string
): string | null {
  if (role === "tool") return "tool_result";

  // Code detection
  if (
    /```[\s\S]{10,}```/.test(content) ||
    /^(import |export |function |class |const |let |var |def |fn )/.test(content.trim()) ||
    /\.(ts|js|py|rs|go|java|rb|cpp|c|sh):\d+/.test(content)
  ) {
    return "code";
  }

  // Instruction detection (L3 hint)
  if (
    /\b(always|never|remember that|from now on|don't ever|do not)\b/i.test(content)
  ) {
    return "instruction";
  }

  // Reference detection
  if (
    /https?:\/\/\S{20,}/.test(content) ||
    /\b(documentation|spec|RFC|API reference)\b/i.test(content)
  ) {
    return "reference";
  }

  return null;
}
