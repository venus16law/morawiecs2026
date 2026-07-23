# AI answer helper (Cloudflare Worker)

This Worker answers **every** question guests type into the wedding site. It holds
the Anthropic API key, enforces rate limits, and asks **Claude Haiku** to answer.

**Claude reads the live site.** The Worker fetches the published page, strips it to
readable text, and passes that in as context — so every tab (Bridesmaids, Groomsmen,
Family, Reception, Floral Plans, Vendors) is fair game, and edits to the site show up
in the answers automatically. There is no separate list of facts to maintain.

The page is re-read at most **once an hour** (cached in KV), so a content change can
take up to an hour to reach the answers. To push it through immediately, redeploy
with `wrangler deploy` after bumping `SITE_CACHE_KEY` in `worker.js`.

> ⚠️ **The passcode-gated Planning/budget section is deliberately excluded** (the
> `#budget-modal` element). Vendor costs, payment schedules, and totals are never
> given to Claude, and it's additionally instructed to refuse budget questions.
> If you add another private section, add its selector to `EXCLUDE` in `worker.js`.

The website stays on GitHub Pages. This is the one small hosted piece that a static
site can't do on its own (a public site can't safely hold an API key, and rate
limits can't be enforced in the browser).

If this Worker is ever unreachable — or before you've deployed it — the site falls
back to a set of built-in offline answers, so guests always get something useful.

**Cost:** Claude Haiku is about $1 per million input tokens / $5 per million output.
The site content is ~12k tokens, so the request is sent with **prompt caching** on
that block — the first question writes the cache, and subsequent ones re-read it at
about a tenth of the price. Realistic wedding traffic lands in the low single-digit
dollars. `GLOBAL_PER_DAY` in `worker.js` is a hard ceiling regardless.

---

## One-time setup

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and an
[Anthropic API key](https://console.anthropic.com/settings/keys).

```bash
# 1. Install the Cloudflare CLI and sign in
npm install -g wrangler
wrangler login

# 2. From this folder, create the rate-limit storage
cd worker
wrangler kv namespace create RATE_LIMIT
#   -> copy the printed id into wrangler.toml (replace REPLACE_WITH_KV_NAMESPACE_ID)

# 3. Store your Anthropic API key as an ENCRYPTED SECRET
#    (paste the key when prompted — it is never committed to git and never
#     shared with anyone; it lives only in Cloudflare)
wrangler secret put ANTHROPIC_API_KEY

# 4. Deploy
wrangler deploy
#   -> prints your Worker URL, e.g. https://morawiecs-ask.<your-subdomain>.workers.dev
```

> Prefer clicking over the terminal? You can do all of this in the Cloudflare
> dashboard instead: **Workers & Pages → Create → Worker**, paste `worker.js`,
> then under **Settings** add a KV namespace binding named `RATE_LIMIT` and an
> **encrypted** variable named `ANTHROPIC_API_KEY`.

---

## Turn it on in the site

Copy the Worker URL from step 4 and paste it into `index.html` — find this line:

```js
var ASK_AI_ENDPOINT = '';
```

and set it to your URL:

```js
var ASK_AI_ENDPOINT = 'https://morawiecs-ask.your-subdomain.workers.dev';
```

Commit that one-line change and GitHub Pages redeploys. Until it's set, the site
runs on the built-in offline answers only.

The Worker URL is **not** a secret — it's a public endpoint, protected by the
rate limits and the origin lock. Only the API key is sensitive.

---

## Notes

- `ALLOWED_ORIGIN` in `worker.js` is locked to `https://venus16law.github.io`, so
  only the wedding site can call it. Update it if the site ever moves.
- The wedding facts live in `WEDDING_FACTS` in `worker.js`. Edit there and redeploy
  if a detail changes (e.g. the shuttle decision in September).
- Rate limits (`PER_IP_PER_MIN`, `PER_IP_PER_DAY`, `GLOBAL_PER_DAY`) are near the
  top of `worker.js`. Counters use Workers KV and are approximate — fine at this
  scale.
