// §5.4 / §7 — Vision confirmation of an ambiguous creative candidate.
//
// Only called when more than one image candidate survives capture (a narrow
// classification task, not deep reasoning — Sonnet 5 is sufficient per §7;
// no need for Fable here).
//
// Requires ANTHROPIC_API_KEY. Without it — running the offline demo, or CI
// before the secret is configured — this falls back to a documented
// heuristic ranking instead of failing the run. A wrong creative guess is a
// human-reviewable annotation (the design team sees the URL either way), not
// a reason to break the pipeline.

const MODEL = 'claude-sonnet-5';

// Preference order when no vision call is available: a page's own og:image
// is the most deliberate "this is our promo image" signal, alt-text naming
// the card is next, and position-near-the-offer-text is the weakest signal
// (most likely to catch a nav logo that just happens to sit nearby).
const SOURCE_PRIORITY = ['og:image', 'alt-text-match', 'largest-near-offer'];

function heuristicPick(candidates) {
  for (const key of SOURCE_PRIORITY) {
    const hit = candidates.find((c) => c.source.split('+').includes(key));
    if (hit) return { url: hit.url, method: 'heuristic-fallback' };
  }
  return { url: candidates[0].url, method: 'heuristic-fallback' };
}

/**
 * @param {object} args
 * @param {Array<{url: string, source: string, alt: string}>} args.candidates
 * @param {string} [args.issuer]
 * @param {string} [args.product]
 * @param {string} [args.apiKey]      Defaults to process.env.ANTHROPIC_API_KEY.
 * @param {Function} [args.fetchImpl] Injectable for tests; defaults to global fetch.
 * @returns {Promise<{ url: string, method: string }>}
 */
export async function confirmCreativeCandidate({
  candidates,
  issuer,
  product,
  apiKey = process.env.ANTHROPIC_API_KEY,
  fetchImpl = fetch,
} = {}) {
  if (!candidates?.length) return { url: null, method: 'no-candidates' };
  if (!apiKey) return heuristicPick(candidates);

  const label = [issuer, product].filter(Boolean).join(' ') || 'this card';
  const prompt =
    `Which of these images is the actual promotional welcome-offer banner for ${label} ` +
    `— not a nav logo, icon, or unrelated asset? Reply with strict JSON only, no prose: ` +
    `{"index": <0-based index of the correct image>}\n\n` +
    candidates.map((c, i) => `${i}: ${c.url}`).join('\n');

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
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...candidates.map((c) => ({ type: 'image', source: { type: 'url', url: c.url } })),
            ],
          },
        ],
      }),
    });
    if (!res.ok) return heuristicPick(candidates);

    const data = await res.json();
    const text = data?.content?.find((b) => b.type === 'text')?.text ?? '';
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    const chosen = candidates[parsed.index];
    return chosen ? { url: chosen.url, method: 'vision' } : heuristicPick(candidates);
  } catch {
    return heuristicPick(candidates);
  }
}
