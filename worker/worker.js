/**
 * Cloudflare Worker — AI fallback for the wedding site's "Ask a question" box.
 *
 * The static site (GitHub Pages) answers the common questions itself, instantly
 * and offline. When it can't, it POSTs the question here. This Worker holds the
 * Anthropic API key as a secret, enforces rate limits, and asks Claude Haiku to
 * answer using ONLY the wedding facts below. Nothing here is ever shown a secret
 * from the browser, and the site keeps working (offline answers) if this is down.
 *
 * Deploy: see README.md in this folder.
 */

const ALLOWED_ORIGIN = 'https://venus16law.github.io';
const MODEL = 'claude-haiku-4-5';

// ── Rate-limiting guardrails (tune freely) ──────────────────────────────
const PER_IP_PER_MIN = 6;    // one person, per minute
const PER_IP_PER_DAY = 40;   // one person, per day
const GLOBAL_PER_DAY = 500;  // hard ceiling on total questions/day (cost cap)

// ── The only facts Claude is allowed to answer from ─────────────────────
const WEDDING_FACTS = `
COUPLE: Venus Law & Matthew Morawiec. Their day-of coordinator is Desiree.

WEDDING DAY — Tuesday, November 10, 2026, at the Bel-Air Bay Club,
16801 Pacific Coast Hwy, Pacific Palisades, CA 90272.
- Please arrive by 4:00 pm (doors open then). Guests may not come onto the
  property more than 30 minutes before that.
- Ceremony begins at 4:30 pm, outdoors on the Lawn overlooking the ocean.
  If it rains, the ceremony moves indoors to the Living Room (decided by the
  morning of).
- Reception follows and ends at 10:00 pm.
- Dress code: Formal.
- About 80 guests.
- Parking: valet through Quality Parking. The lot is small (~35 cars), so
  carpooling or a rideshare is encouraged. Valet contact: Matt, (818) 254-5115.
- November evenings by the ocean can be cool — a wrap or light jacket is smart.

AFTER PARTY — Tuesday, Nov 10, ~10:30 pm at Tiny's Hi-Dive in Santa Monica
(open until 2 am, walk-in). A shuttle from the venue is being explored (decision
in September); otherwise it's a short rideshare.

WELCOME DRINKS — Monday, Nov 9, 7:30 pm at Santa Monica Brew Works,
1920 Colorado Ave, Santa Monica. All guests welcome. Dress: California Cocktail Chic.

REHEARSAL DINNER — Monday, Nov 9, 5:00 pm at Sogno Toscano,
1512 Montana Ave, Santa Monica. Wedding party only.

SEND-OFF BRUNCH — Wednesday, Nov 11, 11:00 am at Clover Park, Santa Monica.
Casual — sweatpants encouraged.

WHERE TO STAY — Guest rooms at the Bel-Air Bay Club: (310) 230-4700 or
ucfrontdesk@belairbayclub.com. Santa Monica (about 15–20 minutes away, near the
welcome events) also has many hotels.

RSVP — Handled through The Knot invitation.

NOT LISTED HERE — Registry and whether children are included are not specified;
for those, guests should reach out to Venus & Matthew directly.
`.trim();

const SYSTEM_PROMPT =
  "You are a warm, friendly assistant for the wedding website of Venus Law and " +
  "Matthew Morawiec. Answer a guest's question using ONLY the wedding details " +
  "below. Keep answers short (1–3 sentences), specific, and welcoming. If the " +
  "detail isn't in the information below, say you don't have that detail and " +
  "suggest they reach out to Venus and Matthew directly — do not guess or invent " +
  "times, places, prices, or policies. Only answer questions about this wedding.\n\n" +
  "WEDDING DETAILS:\n" + WEDDING_FACTS;

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

    // Parse + clamp the question length.
    let question = '';
    try {
      const body = await request.json();
      question = String(body.question || '').slice(0, 400);
    } catch (_) { /* fall through to empty check */ }
    if (!question.trim()) return json({ error: 'empty_question' }, 400, cors);

    // ── Rate limiting (Workers KV counters; approximate, which is fine here) ──
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

    // ── Ask Claude Haiku ──
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
          system: SYSTEM_PROMPT,
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

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

// Increment a KV counter and return the new value. `ttl` seconds keeps the
// namespace self-cleaning (minimum allowed TTL is 60s).
async function bump(kv, key, ttl) {
  const next = (parseInt((await kv.get(key)) || '0', 10) || 0) + 1;
  await kv.put(key, String(next), { expirationTtl: ttl });
  return next;
}
