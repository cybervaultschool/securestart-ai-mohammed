# Defenssive Security Self-Assessment

A free, plain-language security self-assessment for small businesses, at
https://assessment.defenssive.dev/. The visitor answers thirteen questions and gets an educational
readiness score out of 26 plus up to three prioritized actions with practical first steps. It is
educational guidance only: it never inspects, scans or verifies a visitor's systems.

## The five-screen journey

1. **Home** — purpose, limitation notice, Start assessment.
2. **Assessment** — thirteen questions, one at a time, each with a one-line help text. Answers:
   **Yes** (2 points), **Partly** (1), **Not sure** (0), **No** (0). An answer is required to continue.
3. **Review answers** — every answer with an Edit link.
4. **Results** — score out of 26, strengths, areas requiring attention, results wording (below),
   **Clear my answers**, and two calls to action (book a free 30-minute review; the Microsoft 365 product).
5. **Action plan** — up to three actions, then the optional AI Advisor, Email my report, and the
   same two calls to action.

### Scoring, actions and wording (all in `site/assessment.js`)

- Maximum score is **26** (13 × 2). The number is derived, never typed in.
- **Action choice is by risk, not question order.** Risk order: MFA for email, MFA for administrators,
  remote access, backups, separate administrator accounts, updates, endpoint protection, password
  manager, leavers, sharing, encryption, training, incident plan. All **No** answers are taken in that
  order, then all **Not sure**, then all **Partly**, and the first three are shown.
- A **Not sure** answer produces the action "Find out: <topic>" with the first step "Ask your IT provider
  or check the settings, then answer this question again."
- **Wording by percentage:** 75% or more = "most practices are in place"; 40–74% = "some are in place and
  others are missing or only partly in place"; below 40% = "several are not yet in place".
- **Critical-gap override:** if MFA for email, MFA for administrators or backups is answered **No**, the
  page never says "most practices" and shows "Your answers show at least one important gap. Start with the
  actions below." instead, whatever the score.
- **A perfect score** says: "You answered Yes to all thirteen practices. These are your own answers, not a
  test of your systems. Repeat this assessment periodically." It never says all practices are in place or
  implies the business is secure.
- The educational disclaimer appears wherever results are shown.

Saved progress lives only in the visitor's browser (`localStorage`, key `securestart_v2`, 13 answers).
Anything else, including the old `securestart_v1` data, is ignored. **Clear my answers** and **Start a new
assessment** remove it.

## How it is built

| Part | File | Notes |
| --- | --- | --- |
| Questions, scoring, wording | `site/assessment.js` | One plain ES module. The browser **and both functions** import it, so the page, the email and the AI check cannot disagree. |
| Interface | `site/app.js` | Plain React (`createElement`, no JSX, no build step, no `eval`). React 18.3.1 is loaded from unpkg **with SRI hashes**. |
| Styles | `site/styles.css` | defenssive.com tokens; Inter is self-hosted (`site/assets/inter-latin.woff2`); no Google Fonts request. |
| Pages | `site/index.html`, `site/privacy.html` | `/privacy` is routed by `netlify.toml`. |
| Email | `netlify/functions/send-report.mjs`, `netlify/lib/send-report-core.mjs` | `POST /api/send-report` |
| AI | `netlify/functions/ai-guidance.mjs` | `POST /api/ai-guidance` |
| Config | `netlify.toml`, `package.json` | Build guard, headers, redirect. The only dependency is `@netlify/blobs` (pinned), used for rate-limit counters. |

The previous Claude Design runtime was removed on purpose: it compiles the page with `eval`/`new Function`
and Babel in the browser, which a safe Content-Security-Policy forbids.

### Open it locally

```bash
python -m http.server 8742 --directory site
```

Then visit `http://localhost:8742/`. An internet connection is needed (React loads from unpkg). The two
`/api/...` endpoints only exist on Netlify, so locally the AI and email features show their friendly
"unavailable" messages. To preview with mocked APIs and the production security headers:

```bash
node scripts/test-ui.mjs --serve 8750
```

## Email My Report (`/api/send-report`)

The browser sends exactly three fields: `recipientEmail`, `answers` (13 values from `yes`, `partly`,
`unsure`, `no`) and `turnstileToken`. **Nothing else is accepted**; unknown fields are rejected. The server
recomputes the score, strengths, gaps and the three actions from the answers with the same module as the
page, and builds the email only from that data (everything HTML-escaped). A visitor therefore cannot make
the endpoint send arbitrary text from our domain.

- **Bot check:** Cloudflare Turnstile, verified on the server before anything is sent.
- **Rate limits:** 3 reports per IP address per hour and 2 per recipient address per day (HTTP 429 with
  `Retry-After`), plus Netlify's edge limit of 3 requests per 60 seconds per IP and domain. Counters are kept
  in Netlify Blobs under salted SHA-256 hashes, so no raw IP or email address is stored. A failed send still
  counts. Counters are best-effort (the store has no atomic increment), so a burst of simultaneous requests
  could slip a few extra through.
- **Body size limit:** 4 KB. Malformed input gets one generic message. No stack traces, provider text or
  secrets are returned or logged. Logs hold fixed phrases only (never an address, answers, an IP or a token).
- **The email** is plain text plus simple HTML, has no images, links or tracking pixels, says "You asked for
  this report at assessment.defenssive.dev" and gives `contact@defenssive.com`. It never contains AI content.
- **Sender:** `reports@securestart.defenssive.dev` (the domain verified in Resend).

## AI Advisor (optional, `/api/ai-guidance`)

On the Action plan the visitor can pick **Business owner** or **IT administrator** and select **Generate AI
Guidance**. Claude writes a short explanation of priorities that Defenssive has already chosen.

**The deterministic result stays authoritative.** The server recomputes the score and actions from the
answers. Claude may return only a `controlId` and an `explanation` per priority; the server accepts the answer
only if the control IDs, count and order match its own selection, then attaches the approved title, area and
first step itself. The page additionally accepts a response only if its score, maximum score, action titles,
areas and first steps equal the page's own. Model text is rendered as plain text, never as HTML.

**Data boundaries.** Before the button the page says: "Your answers (not your name or email) are sent to an AI
service to write this guidance." Browser → Netlify Function carries only the answers and the audience. Netlify
Function → Claude carries a smaller server-built summary (audience, score, strength and gap identifiers and
the approved actions). No name, company or email address is ever sent. AI guidance is not printed or emailed.

**Behaviour:** an 8.5-second application timeout (Netlify's synchronous limit is 60 seconds); 3 requests per
180 seconds per IP and domain (Netlify only accepts windows of 10–180 s; enforcement is delayed, so a request
just over the limit may succeed; the 429 has an empty body and no `Retry-After`, and the page handles it before
parsing, showing a "wait about three minutes" message); no request when every answer is Yes; refusal, provider
401/429, timeout, malformed output and 5xx all give one generic message; the score, actions, Print and Email
stay usable.

## Configuration (Netlify → Site configuration → Environment variables)

Never commit these, print them or put them in screenshots.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | AI Advisor key (server only). |
| `CLAUDE_MODEL` | Set to `claude-sonnet-5-5`. |
| `AI_ADVISOR_ENABLED` | Must be exactly `true` to switch the AI Advisor on. |
| `RESEND_API_KEY` | Email delivery (server only). |
| `TURNSTILE_SECRET_KEY` | Bot-check secret (server only). Email fails closed without it. |
| `RATE_LIMIT_SALT` | Optional random string that salts the rate-limit hashes. |

The **public** Turnstile site key goes in `site/index.html`, in `<meta name="turnstile-site-key" content="">`.
While it is empty the email form shows "Email delivery is not switched on yet" (it fails closed).

## Security headers

Set in `netlify.toml` for every page: a Content-Security-Policy with no `unsafe-eval` and no
`unsafe-inline` (`default-src 'self'`; scripts only from this site, `unpkg.com` and
`challenges.cloudflare.com`; `frame-src` only Cloudflare; `frame-ancestors 'none'`; `base-uri`, `form-action`
`'self'`; `object-src 'none'`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(),
geolocation=()` and `Strict-Transport-Security: max-age=31536000; includeSubDomains`. The tool cannot be
embedded in other sites; defenssive.com links to it instead. Turnstile's script is the one third-party script
that cannot have an SRI hash.

Netlify may inject its own **"Powered by Netlify" badge** (`/.netlify/scripts/hud`). It is not part of this
repository and its inline styles conflict with this CSP. Turn it off in the Netlify project settings.

## Privacy notice

`site/privacy.html` (`/privacy`). Facts the owner must still confirm are marked **[OWNER TO CONFIRM]**: how
long Anthropic keeps AI requests, how long Netlify keeps logs, and how long the hashed rate-limit counters stay
in the store (they expire logically after 1 hour or 1 day but are only overwritten, not deleted).

## Checks

Run from the project folder (Node.js only). The browser tests need Microsoft Edge and an internet connection
(React loads from unpkg); no test calls Anthropic, Resend or Cloudflare, and none needs a real key.

```bash
node scripts/verify-site.mjs
```

```bash
node scripts/test-assessment.mjs
```

```bash
node scripts/test-ai-guidance.mjs
```

```bash
node scripts/test-send-report.mjs
```

```bash
node scripts/test-ui.mjs
```

Optionally load the real Turnstile widget (Cloudflare's public test key) under the CSP:

```bash
node scripts/test-ui.mjs --real-turnstile
```

Netlify runs only the build guard (`verify-site.mjs`) and fails the deploy if a safety property breaks. Run the
others before every push.

## Limitations

- **Educational guidance only.** Based only on the visitor's answers; not a vulnerability score, compliance
  result, audit or guarantee. No system scanning. No login. No database for assessments.
- **AI is optional and never decides.** Its text can be generic or imperfect.
- Rate limits are best-effort; Netlify enforces its edge limit with a short delay.

## Warning

Do **not** enter real passwords, credentials, customer records or other confidential information anywhere in
this application.
