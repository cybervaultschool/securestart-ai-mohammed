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
   visitor can also email themselves the report (see below).

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
  the privacy statement is missing, if the function's approved content no longer
  matches the app, or if the route or rate limit changes. A copy or re-export
  therefore cannot silently remove the email feature.

## Checks

Run both from the project folder (Node.js only, no installs):

```bash
node scripts/verify-site.mjs
```

```bash
node scripts/test-send-report.mjs
```

## Current limitations

- **Educational guidance only.** The result is based only on your answers. It is
  not a vulnerability score, a compliance result, a professional audit, or a
  guarantee of security.
- **No system scanning.** The website never inspects, scans, or verifies your
  systems.
- **No login or user accounts.**
- **No database.** Your assessment is calculated in your browser. If you choose
  Email My Report, your email address and assessment report are securely sent to
  our email provider only for report delivery.
- **No AI API integration.** Recommendations come from a fixed, human-written
  mapping — no AI service is called.

## Warning

Do **not** enter real passwords, credentials, customer records, or any other
confidential information anywhere in this application. It only ever needs
Yes / Partly / No answers, and an email address if you choose Email My Report.
