/** A named pattern for text that addresses the judge instead of describing an action. */
export interface PromptLikePattern {
  name: string;
  pattern: RegExp;
}

/**
 * Phrases aimed at a model judge (T6). Matching them never changes a feature: they
 * are only flagged so the audit log can show that the state carried prompt-like text.
 */
export const PROMPT_LIKE_PATTERNS: ReadonlyArray<PromptLikePattern> = Object.freeze([
  {
    name: "ignore-instructions",
    pattern:
      /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|prompts?|rules|messages)/i,
  },
  {
    name: "safety-assertion",
    pattern:
      /\b(?:this|the)\s+(?:action|command|call|request|operation|tool call)\s+is\s+(?:safe|harmless|benign|approved|allowed|authori[sz]ed)/i,
  },
  {
    name: "answer-directive",
    pattern:
      /\b(?:answer|respond|reply|say|output|return)\s+(?:with\s+)?["'`]?(?:yes|true|allow|approved?|safe)\b/i,
  },
  {
    name: "role-override",
    pattern: /\b(?:you are now|act as|pretend to be|new instructions|system prompt)\b/i,
  },
  {
    name: "judge-address",
    pattern: /\b(?:dear\s+)?(?:judge|reviewer|classifier|security model|jev(?:dict)?)\s*[,:]/i,
  },
]);

/**
 * Names of the prompt-like patterns found in `text`, each once, in table order. Pure;
 * the audit log records the names, never used to lower or raise a feature.
 */
export function findPromptLikeStrings(text: string): string[] {
  return PROMPT_LIKE_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}
