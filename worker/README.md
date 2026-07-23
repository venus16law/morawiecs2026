# AI answer helper (Cloudflare Worker)

The wedding site answers the common questions itself — instantly, offline, free.
This little Worker is the **fallback** for anything the site can't answer: it holds
the Anthropic API key, enforces rate limits, and asks **Claude Haiku** to answer
using only the wedding details baked into `worker.js`.

The website stays on GitHub Pages. This is the one small hosted piece that a static
site can't do on its own (a public site can't safely hold an API key, and rate
limits can't be enforced in the browser).

**Cost:** Claude Haiku is about $1 per million input tokens / $5 per million output.
Each question is a few hundred tokens, so realistic wedding traffic costs pennies.
The `GLOBAL_PER_DAY` cap in `worker.js` is a hard ceiling so it can never surprise you.

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
var ASK_AI_ENDPOINT = ''; // set to your Cloudflare Worker URL to enable AI answers
```

and set it to your URL:

```js
var ASK_AI_ENDPOINT = 'https://morawiecs-ask.your-subdomain.workers.dev';
```

Commit that one-line change and GitHub Pages redeploys. Until it's set, the site
behaves exactly as before (instant offline answers only) — so merging the PR
changes nothing live on its own.

---

## Notes

- `ALLOWED_ORIGIN` in `worker.js` is locked to `https://venus16law.github.io`, so
  only the wedding site can call it. Update it if the site ever moves.
- The wedding facts live in `WEDDING_FACTS` in `worker.js`. Edit there and redeploy
  if a detail changes (e.g. the shuttle decision in September).
- Rate limits (`PER_IP_PER_MIN`, `PER_IP_PER_DAY`, `GLOBAL_PER_DAY`) are near the
  top of `worker.js`. Counters use Workers KV and are approximate — fine at this
  scale.
