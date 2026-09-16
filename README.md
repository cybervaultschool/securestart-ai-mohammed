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
   why it matters, the first practical step, and the related control area.

Scoring: Yes = 2 points, Partly / Unsure = 1 point, No = 0 points (maximum 20).
Recommendations follow a fixed approved mapping: actions for No answers first, then
Partly / Unsure answers, in question order.

## How to open the application

The app is a single HTML file rendered by a bundled runtime. Serve the project
folder over HTTP and open it in a browser:

```bash
python -m http.server 8742
```

Then visit: `http://localhost:8742/SecureStart%20AI.dc.html`

Notes:
- An internet connection is required (the runtime loads React from a CDN).
- Opening the file directly from disk may not work in every browser; the local
  server method above is the reliable way.
- Answers are saved only in your own browser (localStorage). Use
  **Start a New Assessment** to reset.

## Current limitations

- **Educational guidance only.** The result is based only on your answers. It is
  not a vulnerability score, a compliance result, a professional audit, or a
  guarantee of security.
- **No system scanning.** The website never inspects, scans, or verifies your
  systems.
- **No login or user accounts.**
- **No database.** Nothing you enter leaves your browser.
- **No AI API integration.** Recommendations come from a fixed, human-written
  mapping — no AI service is called.

## Warning

Do **not** enter real passwords, credentials, customer records, or any other
confidential information anywhere in this application. It only ever needs
Yes / Partly / No answers.
