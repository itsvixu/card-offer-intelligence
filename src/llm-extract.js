// §5.2 / §7 — LLM extraction fallback for low-confidence parses.
//
// When the regex pass (§5.2) produces low confidence — e.g., a non-standard
// offer like Discover's Cashback Match, or Amex's "apply to see your
// personalized offer" ceiling rather than a guaranteed amount — this uses
// Sonnet 5 as a final check. A short, well-scoped, structured-output task
// (JSON schema only, no prose).
//
// Gracefully degrades without an API key, leaving the regex result as-is
// (confidence: "low"). This is safe — NEEDS_REVIEW is the correct routing
// for offers we can't parse with high confidence.

const MODEL = 'claude-sonnet-5';

/**
 * Ask Sonnet 5 to parse an offer from raw text, returning a structured object
 * matching the §6 parsedOffer schema. Used only when regex confidence is low.
 *
 * @param {string} rawOfferText    The plain-text offer copy from the page
 * @param {object} [regexResult]   The partial parse from the regex pass (for context)
 * @param {string} [apiKey]        Defaults to process.env.ANTHROPIC_API_KEY
 * @param {Function} [fetchImpl]    Injectable for tests; defaults to global fetch
 * @returns {Promise<{success: boolean, offer: object|null, error: string|null}>}
 */
export async function extractOfferWithLLM(
  rawOfferText,
  regexResult = {},
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = fetch
) {
  if (!apiKey) {
    return { success: false, offer: null, error: 'no-api-key' };
  }

  const prompt = `Parse this credit card welcome offer text into structured JSON. Return ONLY a JSON object (no markdown, no prose) matching this exact schema — use null for any field you cannot determine:

{
  "bonusAmount": <number or null>,
  "bonusAmountMax": <number or null if this is a ceiling ("up to X"), else null>,
  "isTargeted": <true if the offer is personalized/variable, else false>,
  "bonusUnit": <"points" | "miles" | "avios" | "percent-cashback" | "cashback" | null>,
  "spendRequirement": <number or null>,
  "spendCurrency": <"USD" | "GBP" | "EUR" | null>,
  "spendWindowDays": <number of days or null>,
  "annualFee": <number or null>
}

Offer text:
${rawOfferText}`;

  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      return { success: false, offer: null, error: `http-${res.status}` };
    }

    const data = await res.json();
    const text = data?.content?.find((b) => b.type === 'text')?.text ?? '';
    const jsonStr = text.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonStr) {
      return { success: false, offer: null, error: 'no-json-in-response' };
    }

    const parsed = JSON.parse(jsonStr);
    // Only a parse that found both a bonus and a spend requirement counts as
    // confident. A reply of all nulls means the model could not read the
    // offer either, and must stay "low" so it routes to NEEDS_REVIEW.
    const hasBonus = parsed.bonusAmount != null || parsed.bonusAmountMax != null;
    const confident = hasBonus && parsed.spendRequirement != null;
    return {
      success: true,
      offer: {
        bonusAmount: parsed.bonusAmount ?? null,
        bonusAmountMax: parsed.bonusAmountMax ?? null,
        isTargeted: parsed.isTargeted ?? false,
        bonusUnit: parsed.bonusUnit ?? null,
        spendRequirement: parsed.spendRequirement ?? null,
        spendCurrency: parsed.spendCurrency ?? null,
        spendWindowDays: parsed.spendWindowDays ?? null,
        annualFee: parsed.annualFee ?? null,
        confidence: confident ? 'high' : 'low',
        extractionMethod: 'llm',
      },
      error: null,
    };
  } catch (err) {
    return { success: false, offer: null, error: err.message };
  }
}
