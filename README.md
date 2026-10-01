# SecureStart AI

SecureStart AI is a simple educational website that helps a small business find out
which basic cybersecurity steps to take first. The user answers ten plain-language
questions and receives an educational readiness score out of 20, plus three
prioritized security actions with practical first steps.

## Who it is for

A non-technical small-business owner or office manager — someone who handles the
computers but has no cybersecurity background and no security specialist to ask.
No technical experience is required to complete the assessment.

## The five-screen journey

1. **Home** — explains the purpose and audience, shows the limitation notice, and
   starts the assessment.
2. **Assessment** — ten questions, shown one at a time, with Yes / Partly-Unsure / No
   answers and a progress indicator. Earlier answers are kept when moving back.
3. **Review Answers** — all ten answers listed with an Edit link for each. Results
   cannot be calculated while an answer is missing.
4. **Results** — the educational score out of 20, strengths from Yes answers, and
   areas requiring attention from No and Partly / Unsure answers.
5. **Action Plan** — the first three recommended actions, each with what to do,
   why it matters, the first practical step, and the related control area. The
   visitor can also email themselves the report and, optionally, ask the AI Advisor
   to explain the priorities (see below).

Scoring: Yes = 2 points, Partly / Unsure = 1 point, No = 0 points (maximum 20).
Recommendations follow a fixed approved mapping: actions for No answers first, then
Partly / Unsure answers, in question order.

## How to open the application

The app is a single HTML file rendered by a bundled runtime. To preview the deployed
site locally, serve the `site` folder over HTTP and open it in a browser:

```bash
python -m http.server 8742 --directory site
```

Then visit: `http://localhost:8742/`

Notes:
- An internet connection is required (the runtime loads React from a CDN).
- Opening the file directly from disk may not work in every browser; the local
  server method above is the reliable way.
- Answers are saved only in your own browser (localStorage). Use
  **Start a New Assessment** to reset.
- The email function runs on Netlify, not on this local server, so **Email My
  Report** shows its "could not send" message when previewed locally.

## Email My Report

On the Action Plan screen a visitor can enter an email address and receive their
report by email.

> Your assessment is calculated in your browser. If you choose Email My Report,
> your email address and assessment report are securely sent to our email provider
> only for report delivery.

How it works: the browser sends the report to `/api/send-report`, a Netlify
Function (`netlify/functions/send-report.mjs`) that calls the Resend email API.
The API key exists only on the server and is never in the page or the repository.

Safeguards:
- **Approved content only.** The function knows the assessment's ten control areas,
  the answer levels, and the approved action text. It rebuilds the score and the
  three actions from the answers and rejects any request that differs in any way.
  Visitors cannot supply free text, HTML, a subject, a sender, a reply-to address,
  or extra recipients.
- **One plain email address per request.** Lists, display names, and unusual
  characters are rejected.
- **Fixed sender and subject.** Every value is also HTML-escaped.
- **Rate limit.** Netlify allows 3 requests per 60 seconds per IP address and domain
  on this route (declared in the function's `config`).
- **Generic errors.** The page shows one plain-language message and never provider
  details. The key is never logged.

Configuration (never commit these):
- Netlify environment variable `RESEND_API_KEY` (Site configuration → Environment
  variables).
- The sending domain `securestart.defenssive.dev` must be verified in Resend.

## AI Advisor (optional)

On the Action Plan screen a visitor can choose **Business owner** or **IT
administrator** and select **Generate AI Guidance**. Claude then writes a short
plain-language explanation of the priorities that SecureStart has already chosen.

**SecureStart stays authoritative.** The score, the strengths and gaps, and the
three priority actions always come from the approved rules, never from AI, and the
page is complete without the AI Advisor. The server recalculates everything from
the answers. Claude can only return a `controlId` and an `explanation` for each
priority. The server accepts the response only if the control IDs, their count and
their order match its own selection, then attaches the approved title, area and
first step itself. The page also rejects any response that disagrees with its own
result. Model text is shown as plain text (never as HTML), and a field that contains
markup, links or unexpected keys causes the whole response to be discarded.

### Data boundaries

- **Browser to the SecureStart Netlify Function.** `POST /api/ai-guidance` carries
  exactly two things: the ten answers and the chosen audience. No name, company or
  email address is collected or sent. The browser never calls Anthropic and never
  sees the API key.
- **Netlify Function to Claude.** Only a smaller, server-derived summary is sent:
  the audience, the score, strength and gap identifiers, and the approved priority
  actions. Claude never receives the raw request, a name, a company or an email
  address.
- The page tells the visitor this before they click, in the `ai-disclosure`
  paragraph.
- AI guidance is **not** included in the printed plan (the AI card is hidden when
  printing) and **not** included in the emailed report (the `/api/send-report`
  request contains no AI content, and that function accepts none).

### The endpoint

`/api/ai-guidance` is a Netlify Function (`netlify/functions/ai-guidance.mjs`). It
calls the Claude Messages API with native `fetch` (no SDK or dependencies).

Configuration (Site configuration → Environment variables; never commit values):

| Variable | Value | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | your key (secret) | Server-side only. Never in the page, responses, logs or Git. |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | The model the function calls. |
| `AI_ADVISOR_ENABLED` | `true` | Switch. Anything else (or a missing variable) disables the feature. |

If any of these is missing, the function answers with the same generic
"unavailable" message and the rest of the site keeps working.

Behaviour and limits:
- **8.5-second application timeout.** The function gives up on Claude after 8.5
  seconds to keep the page responsive and the cost low. This is a deliberate
  application setting, not a platform limit; Netlify's synchronous function limit
  is 60 seconds.
- **Rate limit.** 3 requests per 180 seconds, per IP address and domain, declared in
  the function's `config`. Netlify only accepts windows of 10 to 180 seconds and
  silently ignores others. Enforcement is **delayed**: it can take several seconds
  to start, so a request just over the limit may still succeed. When the limit is
  hit, Netlify returns HTTP 429 with an empty body and no `Retry-After` header; the
  page checks the status before reading any body and shows a "wait about three
  minutes" message.
- **Zero gaps.** If every answer is Yes there is nothing to prioritise, so the page
  makes no AI request and says no explanation is needed.
- **Safe failures.** A refusal, provider 401 or 429, a timeout, malformed or invalid
  output or a 5xx all produce one generic message. Provider text, stack traces and
  keys are never returned or logged; the log records only a short category. The
  score, actions, **Print Action Plan** and **Email My Report** stay usable.
- Duplicate clicks send one request, and a response that arrives after the answers
  change is ignored.

## Source of truth and deployment

- `SecureStart AI.dc.html` is the **source** of the application.
- `site/index.html` is the **deployed copy** that Netlify publishes. It must equal
  the source, plus optionally one temporary footer line ("Training deployment: Day 6").
- After editing the source, refresh the deployed copy:

```bash
cp "SecureStart AI.dc.html" site/index.html
```

- Netlify runs `node scripts/verify-site.mjs` as its build command. The deploy
  **fails** if the deployed page differs from the source, if the email feature or
  the privacy statement is missing, if the functions' approved content no longer
  matches the app, if either route or rate limit changes, or if the AI Advisor
  interface stops meeting its safety rules (plain-text rendering, no direct provider
  call, exact disclosure, print exclusion). A copy or re-export
  therefore cannot silently remove the email feature.

## Checks

Run these from the project folder (Node.js only, no installs). The browser tests
also need Microsoft Edge installed and an internet connection (the page loads React
from a CDN). The APIs are mocked, so no test calls Anthropic or Resend, and none
needs a real key.

Build guard:

```bash
node scripts/verify-site.mjs
```

Browser (UI) tests, including the AI Advisor interface:

```bash
node scripts/test-ui.mjs
```

AI endpoint tests:

```bash
node scripts/test-ai-guidance.mjs
```

Email regression tests:

```bash
node scripts/test-send-report.mjs
```

Netlify runs only the build guard. Run the other three before every push.

## Current limitations

- **Educational guidance only.** The result is based only on your answers. It is
  not a vulnerability score, a compliance result, a professional audit, or a
  guarantee of security.
- **No system scanning.** The website never inspects, scans, or verifies your
  systems.
- **No login or user accounts.**
- **No database.** Your assessment is calculated in your browser. If you choose
  Email My Report, your email address and assessment report are securely sent to
  our email provider only for report delivery. If you choose Generate AI Guidance,
  your answers and audience are sent to the SecureStart service, which sends Claude
  only a smaller summary (see AI Advisor above).
- **AI is optional and never decides.** Recommendations come from a fixed,
  human-written mapping. The AI Advisor only explains them, and the page works
  without it. AI output can be generic or imperfect, so treat it as a starting point.

## Warning

Do **not** enter real passwords, credentials, customer records, or any other
confidential information anywhere in this application. It only ever needs
Yes / Partly / No answers, and an email address if you choose Email My Report.
