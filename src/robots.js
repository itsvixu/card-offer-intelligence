// §9 — robots.txt compliance. Before a source is fetched, its site's
// robots.txt is read (once per origin per run) and the path checked against
// the rules for our user agent, falling back to the `*` group. A disallowed
// source is reported as a failure in the run report, never fetched anyway.

export const BOT_TOKEN = 'CardOfferMonitor';

function parseRobots(body) {
  const groups = []; // { agents: [], rules: [{ allow, path }] }
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && (field === 'allow' || field === 'disallow') && value) {
        current.rules.push({ allow: field === 'allow', path: value });
      }
    }
  }
  return groups;
}

function ruleMatches(rulePath, path) {
  // Supports the two wildcards in common use: `*` and a trailing `$`.
  const anchored = rulePath.endsWith('$');
  const body = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

/** Longest matching rule wins; Allow wins a tie. No matching rule → allowed. */
export function isPathAllowed(robotsBody, path, token = BOT_TOKEN) {
  const groups = parseRobots(robotsBody);
  const mine = groups.filter((g) => g.agents.includes(token.toLowerCase()));
  const applicable = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!ruleMatches(rule.path, path)) continue;
      if (
        !best ||
        rule.path.length > best.path.length ||
        (rule.path.length === best.path.length && rule.allow)
      ) {
        best = rule;
      }
    }
  }
  return best ? best.allow : true;
}

/** A per-run checker that fetches each origin's robots.txt once. */
export function createRobotsChecker({ fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const cache = new Map();
  return async function isAllowed(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    if (!/^https?:$/.test(parsed.protocol)) return true;

    if (!cache.has(parsed.origin)) {
      let body = '';
      try {
        const res = await fetchImpl(`${parsed.origin}/robots.txt`, {
          headers: { 'User-Agent': BOT_TOKEN },
          signal: AbortSignal.timeout(timeoutMs),
        });
        // No robots.txt (404) or an unreadable one means no stated restriction.
        if (res.ok) body = await res.text();
      } catch {
        body = '';
      }
      cache.set(parsed.origin, body);
    }
    return isPathAllowed(cache.get(parsed.origin), parsed.pathname + parsed.search);
  };
}
