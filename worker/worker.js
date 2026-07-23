/**
 * Cloudflare Worker — the "Ask anything" helper for the wedding site.
 *
 * Claude Haiku answers guests' questions using the *live contents of the
 * wedding site itself*: the Worker fetches the published page, strips it to
 * readable text, and hands that to Claude as context. Update the site and the
 * answers update with it — there is no separate list of facts to maintain.
 *
 * The passcode-gated Planning/budget section is deliberately excluded, so
 * vendor costs and payment schedules are never used to answer a guest.
 *
 * Deploy: see README.md in this folder.
 */

const ALLOWED_ORIGIN = 'https://venus16law.github.io';
const SITE_URL = 'https://venus16law.github.io/morawiecs2026/';
const MODEL = 'claude-haiku-4-5';

// Selectors whose contents are never shown to Claude.
// #budget-modal is the passcode-gated planning section (vendor costs, payments).
const EXCLUDE = 'script, style, #budget-modal';

const SITE_CACHE_KEY = 'site:text:v1';
const SITE_CACHE_TTL = 3600;   // re-read the site at most once an hour
const SITE_TEXT_MAX = 60000;   // hard cap on characters sent as context

// ── Rate-limiting guardrails (tune freely) ──────────────────────────────
// Claude answers every question. Prompt caching keeps repeat questions cheap,
// so the global ceiling below caps a very busy day at a few dollars.
const PER_IP_PER_MIN = 8;     // one person, per minute (stops key-mashing)
const PER_IP_PER_DAY = 60;    // one person, per day
const GLOBAL_PER_DAY = 2000;  // hard ceiling on total questions/day (cost cap)

const INSTRUCTIONS =
  "You are a warm, friendly assistant on the wedding website of Venus Law and " +
  "Matthew Morawiec. Guests ask you questions about the wedding.\n\n" +
  "Answer using ONLY the wedding site content provided below. Keep answers " +
  "short (1–3 sentences), specific, and welcoming.\n\n" +
  "Rules:\n" +
  "- Never invent or estimate times, places, prices, or policies. If a detail " +
  "isn't in the content, say you don't have it and suggest they reach out to " +
  "Venus and Matthew directly.\n" +
  "- Never discuss budgets, vendor costs, payments, or what anything cost. If " +
  "asked, say that isn't something you can help with.\n" +
  "- Only answer questions about this wedding.\n" +
  "- Guests are reading on their phones, often older guests — be clear and kind.";

// A minimal safety net used only if the site can't be fetched.
const FALLBACK_FACTS = `
Venus Law & Matthew Morawiec are marrying on Tuesday, November 10, 2026 at the
Bel-Air Bay Club, 16801 Pacific Coast Hwy, Pacific Palisades, CA 90272.
Arrive by 4:00 pm; the ceremony begins at 4:30 pm outdoors on the Lawn (moves
indoors if it rains). Reception follows and ends at 10:00 pm. Dress code: Formal.
Valet parking is available; the lot is small so carpooling or a rideshare helps.
After party from ~10:30 pm at Tiny's Hi-Dive in Santa Monica.
Welcome Drinks: Monday, Nov 9, 7:30 pm, Santa Monica Brew Works (all guests).
Send-off brunch: Wednesday, Nov 11, 11:00 am, Clover Park, Santa Monica.
`.trim();

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

    let question = '';
    try {
      const body = await request.json();
      question = String(body.question || '').slice(0, 400);
    } catch (_) { /* handled below */ }
    if (!question.trim()) return json({ error: 'empty_question' }, 400, cors);

    // ── Rate limiting (Workers KV counters; approximate, fine at this scale) ──
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = new Date();
    const minBucket = Math.floor(now.getTime() / 60000);
    const day = now.toISOString().slice(0, 10);

    const [perMin, perIpDay, globalDay] = await Promise.all([
      bump(env.RATE_LIMIT, `ip:${ip}:min:${minBucket}`, 120),
      bump(env.RATE_LIMIT, `ip:${ip}:day:${day}`, 90000),
      bump(env.RATE_LIMIT, `global:day:${day}`, 90000),
    ]);

    if (perMin > PER_IP_PER_MIN || perIpDay > PER_IP_PER_DAY) {
      return json({ answer: "You've asked a lot of questions just now — give it a minute and try again, or browse the tabs below." }, 200, cors);
    }
    if (globalDay > GLOBAL_PER_DAY) {
      return json({ answer: "Our quick-answer helper is resting for today — please browse the tabs below, or reach out to Venus & Matthew." }, 200, cors);
    }

    if (!env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 500, cors);

    const siteText = await getSiteText(env);

    let resp;
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          system: [
            { type: 'text', text: INSTRUCTIONS },
            {
              type: 'text',
              text: 'WEDDING SITE CONTENT:\n\n' + siteText,
              // Cache the big context block so repeat questions are ~10% the
              // input cost. The site text is stable, so this hits often.
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: question }],
        }),
      });
    } catch (_) {
      return json({ answer: "Sorry — I couldn't look that up right now. Please browse the tabs below or reach out to Venus & Matthew." }, 200, cors);
    }

    if (!resp.ok) {
      return json({ answer: "Sorry — I couldn't look that up right now. Please browse the tabs below or reach out to Venus & Matthew." }, 200, cors);
    }

    const data = await resp.json();
    if (data.stop_reason === 'refusal') {
      return json({ answer: "I can only help with questions about Venus & Matthew's wedding — try asking about the timing, venue, parking, or dress code!" }, 200, cors);
    }

    const answer =
      (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim() ||
      "I don't have that detail — please reach out to Venus & Matthew directly.";

    return json({ answer }, 200, cors);
  },
};

/**
 * The published site, as plain text. Cached in KV so we read the page at most
 * once an hour rather than on every question.
 */
async function getSiteText(env) {
  try {
    const cached = await env.RATE_LIMIT.get(SITE_CACHE_KEY);
    if (cached) return cached;
  } catch (_) { /* fall through to a fresh read */ }

  try {
    const page = await fetch(SITE_URL, { cf: { cacheTtl: 300 } });
    if (!page.ok) return FALLBACK_FACTS;

    const text = (await htmlToText(page)).slice(0, SITE_TEXT_MAX);
    if (text.length < 500) return FALLBACK_FACTS; // extraction clearly failed

    try {
      await env.RATE_LIMIT.put(SITE_CACHE_KEY, text, { expirationTtl: SITE_CACHE_TTL });
    } catch (_) { /* caching is best-effort */ }

    return text;
  } catch (_) {
    return FALLBACK_FACTS;
  }
}

/**
 * Stream the page through HTMLRewriter, collecting readable text and skipping
 * anything inside EXCLUDE (scripts, styles, and the gated budget section).
 * Block-level tags become newlines so the tab structure survives.
 */
async function htmlToText(response) {
  const parts = [];
  let skip = 0;

  const transformed = new HTMLRewriter()
    .on(EXCLUDE, {
      element(el) {
        skip++;
        el.onEndTag(() => { skip--; });
      },
    })
    .on('div, p, h1, h2, h3, h4, li, tr, br, section', {
      element() { if (skip === 0) parts.push('\n'); },
    })
    .on('*', {
      text(t) { if (skip === 0 && t.text.trim()) parts.push(t.text); },
    })
    .transform(response);

  await transformed.arrayBuffer(); // drive the stream so handlers run

  return parts
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

// Increment a KV counter and return the new value.
async function bump(kv, key, ttl) {
  const next = (parseInt((await kv.get(key)) || '0', 10) || 0) + 1;
  await kv.put(key, String(next), { expirationTtl: ttl });
  return next;
}
