// Defenssive Security Self-Assessment: the whole front end. Plain React (loaded from unpkg with SRI),
// no JSX, no build step, no eval, so the Content-Security-Policy needs neither 'unsafe-eval' nor
// 'unsafe-inline' for scripts. All scoring and wording comes from ./assessment.js.
import {
  ANSWER_LABELS, ANSWER_VALUES, DISCLAIMER, MAX_SCORE, QUESTIONS, QUESTION_COUNT, REVIEW_LINE, assess, gapLabel
} from "./assessment.js"

const { createElement: h, Fragment, useEffect, useRef, useState } = React

const STORAGE_KEY = "securestart_v2"
const SCREENS = ["home", "assessment", "review", "results", "plan"]
const BOOK_URL = "https://defenssive.com/contact#send-a-message"
// The #product section is not live on defenssive.com yet; switch to "https://defenssive.com/#product" once it is.
const PRODUCT_URL = "https://defenssive.com"
const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

const blank = () => ({ screen: "home", qIndex: 0, answers: Array(QUESTION_COUNT).fill(null) })

// Saved progress lives only in this browser. Anything that is not exactly the v2 shape (including
// any old "securestart_v1" data, which is never read) is ignored.
const loadState = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    const valid = saved && typeof saved === "object" && SCREENS.includes(saved.screen) &&
      Number.isInteger(saved.qIndex) && saved.qIndex >= 0 && saved.qIndex < QUESTION_COUNT &&
      Array.isArray(saved.answers) && saved.answers.length === QUESTION_COUNT &&
      saved.answers.every((answer) => answer === null || ANSWER_VALUES.includes(answer))
    if (!valid) return blank()
    const complete = saved.answers.every((answer) => answer !== null)
    const screen = (saved.screen === "results" || saved.screen === "plan") && !complete ? "review" : saved.screen
    return { screen, qIndex: saved.qIndex, answers: saved.answers }
  } catch { return blank() }
}
const saveState = (state) => {
  try {
    if (state.screen === "home" && state.answers.every((answer) => answer === null)) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* storage unavailable: the page still works */ }
}
const clearSaved = () => { try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ } }

// Accepts an AI response only if it agrees with this page's own deterministic result. Only the
// prose may come from the AI; titles, areas and first steps are always the page's own text.
const checkAdvisor = (json, local, audience) => {
  const isText = (value) => typeof value === "string"
  if (!json || json.ok !== true || json.aiGenerated !== true || json.score !== local.score || json.maxScore !== MAX_SCORE) return null
  const advisor = json.advisor
  if (!advisor || !isText(advisor.summary) || !isText(advisor.positiveFinding) || !isText(advisor.limitations) ||
    !Array.isArray(advisor.priorities) || advisor.priorities.length !== local.actions.length) return null
  const priorities = local.actions.map((action, index) => {
    const given = advisor.priorities[index]
    if (!given || given.controlId !== action.id || given.title !== action.title || given.area !== action.area ||
      given.firstStep !== action.first || !isText(given.explanation)) return null
    return { id: action.id, area: action.area, title: action.title, first: action.first, explanation: given.explanation }
  })
  if (priorities.includes(null)) return null
  return { audience, summary: advisor.summary, positive: advisor.positiveFinding, priorities, limitations: advisor.limitations }
}

const siteKey = () => document.querySelector('meta[name="turnstile-site-key"]')?.content?.trim() || ""
let turnstilePromise = null
const loadTurnstile = () => {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  if (!turnstilePromise) {
    turnstilePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script")
      script.src = TURNSTILE_SRC
      script.async = true
      script.onload = () => resolve(window.turnstile)
      script.onerror = () => { turnstilePromise = null; reject(new Error("turnstile")) }
      document.head.appendChild(script)
    })
  }
  return turnstilePromise
}

// ---- small building blocks -------------------------------------------------------------------

const Button = ({ kind = "secondary", ...props }) => h("button", { type: "button", className: `btn btn-${kind}`, ...props })
const LinkButton = ({ kind = "secondary", href, children }) =>
  h("a", { className: `btn btn-${kind}`, href, rel: "noopener" }, children)

// Shown after the results and after the plan.
const NextSteps = () => h("section", { className: "card cta", "data-no-print": "true", "aria-labelledby": "next-steps" },
  h("h2", { id: "next-steps" }, "Want help with the next step?"),
  h("p", null, "A short conversation can turn this list into a plan that fits your business."),
  h("div", { className: "btn-row" },
    h(LinkButton, { href: BOOK_URL }, "Book a free 30-minute review"),
    h(LinkButton, { href: PRODUCT_URL }, "Own Microsoft 365? See our read-only security assessment product")))

// ---- screens ----------------------------------------------------------------------------------

const Home = ({ onStart, headingRef }) => h("div", { className: "stack" },
  h("p", { className: "eyebrow" }, "Free for small businesses"),
  h("h1", { ref: headingRef, tabIndex: -1 }, "Defenssive Security Self-Assessment"),
  h("p", { className: "lead" }, "Understand your basic security readiness. Answer thirteen plain-language questions and get up to three practical actions for your business."),
  h("p", { className: "note" }, "For small-business owners and office managers. No technical experience required. It takes about five minutes."),
  h("div", { className: "btn-row" }, h(Button, { kind: "primary", onClick: onStart }, "Start assessment")),
  h("hr", { className: "divider" }),
  h("p", { className: "note" },
    "Defenssive provides educational guidance based only on your answers. It does not inspect your systems or replace a professional security assessment. Do not enter passwords, credentials, customer records, or confidential information."))

const Question = ({ index, answers, notice, onAnswer, onBack, onNext, headingRef }) => {
  const question = QUESTIONS[index]
  const current = answers[index]
  const last = index === QUESTION_COUNT - 1
  return h("div", { className: "stack" },
    h("h1", { className: "title-sm" }, "Security self-assessment"),
    h("p", { className: "eyebrow" }, `Question ${index + 1} of ${QUESTION_COUNT} · ${question.area}`),
    h("div", {
      className: "progress", role: "progressbar", "aria-label": "Assessment progress",
      "aria-valuemin": 0, "aria-valuemax": QUESTION_COUNT, "aria-valuenow": index + 1,
      "aria-valuetext": `Question ${index + 1} of ${QUESTION_COUNT}`
    }, h("div", { style: { width: `${((index + 1) / QUESTION_COUNT) * 100}%` } })),
    h("fieldset", { ref: headingRef, tabIndex: -1, "aria-describedby": `help-${question.id}` },
      h("legend", null, question.text),
      h("p", { className: "help", id: `help-${question.id}` }, question.help),
      h("div", { className: "options" }, ANSWER_VALUES.map((value) =>
        h("label", { key: value, className: `option${current === value ? " is-selected" : ""}` },
          h("input", { type: "radio", name: `q-${question.id}`, value, checked: current === value, onChange: () => onAnswer(value) }),
          h("span", null, ANSWER_LABELS[value]))))),
    notice ? h("p", { className: "error", role: "alert" }, notice) : null,
    h("div", { className: "btn-row split" },
      h(Button, { onClick: onBack }, "Back"),
      h(Button, { kind: "primary", onClick: onNext }, last ? "Review answers" : "Continue")))
}

const Review = ({ answers, notice, onEdit, onBack, onCalculate, headingRef }) => h("div", { className: "stack" },
  h("h1", { ref: headingRef, tabIndex: -1 }, "Review your answers"),
  h("p", { className: "lead" }, "Check your answers before calculating the result."),
  h("ol", { className: "review" }, QUESTIONS.map((question, index) =>
    h("li", { key: question.id },
      h("span", { className: "num", "aria-hidden": "true" }, index + 1),
      h("span", null, question.text),
      h("span", { className: "ans-cell" },
        h("span", { className: "ans" }, answers[index] ? ANSWER_LABELS[answers[index]] : "Not answered"),
        h("button", { type: "button", className: "link-button", onClick: () => onEdit(index), "aria-label": `Edit answer to question ${index + 1}` }, "Edit"))))),
  h("p", { className: "legend-line" },
    h("span", null, "Yes = 2 points"), h("span", null, "Partly = 1 point"), h("span", null, "Not sure = 0 points"),
    h("span", null, "No = 0 points"), h("span", null, `Maximum score = ${MAX_SCORE}`)),
  notice ? h("p", { className: "error", role: "alert" }, notice) : null,
  h("div", { className: "btn-row split" },
    h(Button, { onClick: onBack }, "Back to assessment"),
    h(Button, { kind: "primary", onClick: onCalculate }, "Calculate results")),
  h("hr", { className: "divider" }),
  h("p", { className: "note" }, "The result is based only on the answers provided. This tool does not verify your systems or security controls."))

const Results = ({ result, onPlan, onReview, onClear, headingRef }) => h("div", { className: "stack" },
  h("h1", { ref: headingRef, tabIndex: -1 }, "Your security readiness summary"),
  h("div", { className: "score" },
    h("span", { className: "big" }, result.score),
    h("span", { className: "of" }, `/ ${result.maxScore} educational score`)),
  h("p", { className: "headline" }, result.headline),
  h("div", { className: "grid-3" },
    h("div", { className: "card" }, h("p", { className: "eyebrow" }, "Completed"), h("p", { className: "stat" }, `${QUESTION_COUNT} of ${QUESTION_COUNT}`)),
    h("div", { className: "card" }, h("p", { className: "eyebrow" }, "Answered Yes"), h("p", { className: "stat" }, result.strengths.length)),
    h("div", { className: "card" }, h("p", { className: "eyebrow" }, "Not yet Yes"), h("p", { className: "stat" }, result.gaps.length))),
  h("div", { className: "grid-2" },
    h("section", { className: "card", "aria-labelledby": "strengths-h" },
      h("h2", { id: "strengths-h" }, "Strengths"),
      result.strengths.length
        ? h("ul", { className: "tags" }, result.strengths.map((question) => h("li", { key: question.id }, question.area)))
        : h("p", { className: "note" }, "No questions were answered Yes.")),
    h("section", { className: "card", "aria-labelledby": "gaps-h" },
      h("h2", { id: "gaps-h" }, "Areas requiring attention"),
      result.gaps.length
        ? h("ul", { className: "tags" }, result.gaps.map((gap) => h("li", { key: gap.question.id, className: "gap" }, gapLabel(gap))))
        : h("p", { className: "note" }, "No areas require attention based on your answers."))),
  h("div", { className: "btn-row", "data-no-print": "true" },
    h(Button, { kind: "primary", onClick: onPlan }, "View my action plan"),
    h(Button, { onClick: onReview }, "Review answers"),
    h(Button, { onClick: () => window.print() }, "Print results")),
  h("p", { className: "note" }, DISCLAIMER),
  h(NextSteps),
  h("div", { "data-no-print": "true" },
    h("button", { type: "button", className: "link-button", onClick: onClear }, "Clear my answers")))

// ---- AI Advisor -------------------------------------------------------------------------------

const AiAdvisor = ({ ai, setAudience, onGenerate }) => {
  const sending = ai.status === "sending"
  const audiences = [["business-owner", "Business owner"], ["it-admin", "IT administrator"]]
  return h("section", { className: "card", "data-no-print": "true", "data-section": "ai-advisor", "aria-labelledby": "ai-advisor-title" },
    h("h2", { id: "ai-advisor-title" }, "AI Advisor"),
    h("p", { className: "note" }, "Optional. Your score and priority actions above come from Defenssive's approved rules, not from AI, and stay complete without it."),
    h("p", { className: "note", id: "ai-disclosure" }, "Your answers (not your name or email) are sent to an AI service to write this guidance."),
    h("fieldset", null,
      h("legend", { className: "eyebrow legend-sm" }, "Explain for"),
      h("div", { className: "grid-2" }, audiences.map(([value, label]) =>
        h("label", { key: value, className: `option${ai.audience === value ? " is-selected" : ""}` },
          h("input", { type: "radio", name: "ai-audience", value, checked: ai.audience === value, disabled: sending, onChange: () => setAudience(value) }),
          h("span", null, label))))),
    h("div", { className: "btn-row" },
      h(Button, { kind: "primary", onClick: onGenerate, disabled: sending }, sending ? "Generating…" : "Generate AI Guidance")),
    ai.status === "idle" ? h("p", { className: "note" }, "AI guidance has not been requested yet. Your score and priority actions above are already complete.") : null,
    sending ? h("p", { className: "status", role: "status" }, "Generating your guidance. This usually takes a few seconds.") : null,
    ai.status === "ratelimited" ? h("p", { className: "status", role: "status" }, "AI Advisor has received a lot of requests and needs a short break. Please wait about three minutes, then try again. Your score and priority actions are not affected.") : null,
    ai.status === "error" ? h("p", { className: "error", role: "alert" }, "AI Advisor is unavailable right now. Please try again later. Your score and priority actions are not affected.") : null,
    ai.result ? h(AiResult, { result: ai.result }) : null)
}

const AiResult = ({ result }) => h("section", { className: "stack-sm", "aria-labelledby": "ai-guidance-title" },
  h("hr", { className: "divider" }),
  h("h3", { id: "ai-guidance-title" }, "AI Advisor Guidance"),
  h("p", { className: "note" },
    h("span", { className: "tag" }, "AI-generated"), " ",
    `Written for: ${result.audience === "it-admin" ? "IT administrator" : "Business owner"}. Action titles, areas and first steps come from Defenssive's approved action plan. Only the summary and explanations are written by AI.`),
  h("p", null, result.summary),
  result.positive ? h("p", null, result.positive) : null,
  result.priorities.map((priority, index) =>
    h("div", { key: priority.id, className: "card priority" },
      h("div", { className: "top" }, h("span", { className: "eyebrow" }, `Priority ${index + 1}`), h("span", { className: "tag" }, priority.area)),
      h("h3", null, priority.title),
      h("p", null, h("span", { className: "italic-label" }, "AI explanation — "), priority.explanation),
      h("p", null, h("span", { className: "italic-label" }, "First practical step (approved) — "), priority.first))),
  h("p", { className: "note" }, h("strong", null, "Limitations — "), result.limitations))

// ---- Email ------------------------------------------------------------------------------------

const EmailCard = ({ answers }) => {
  const [status, setStatus] = useState("idle")
  const [token, setToken] = useState("")
  const [ready, setReady] = useState(false)
  const boxRef = useRef(null)
  const widgetRef = useRef(null)
  const inputRef = useRef(null)
  const key = siteKey()

  useEffect(() => {
    if (!key) return undefined
    let cancelled = false
    loadTurnstile().then((turnstile) => {
      if (cancelled || !boxRef.current || widgetRef.current !== null) return
      widgetRef.current = turnstile.render(boxRef.current, {
        sitekey: key, theme: "dark",
        callback: (value) => setToken(value),
        "expired-callback": () => setToken(""),
        "error-callback": () => setToken("")
      })
      setReady(true)
    }).catch(() => { if (!cancelled) setStatus("unavailable") })
    return () => {
      cancelled = true
      if (widgetRef.current !== null && window.turnstile) { try { window.turnstile.remove(widgetRef.current) } catch { /* ignore */ } }
      widgetRef.current = null
    }
  }, [key])

  const resetWidget = () => {
    setToken("")
    if (widgetRef.current !== null && window.turnstile) { try { window.turnstile.reset(widgetRef.current) } catch { /* ignore */ } }
  }

  const submit = (event) => {
    event.preventDefault()
    if (status === "sending") return
    const input = inputRef.current
    if (!input.value.trim() || !input.checkValidity()) { setStatus("invalid"); return }
    if (!token) { setStatus("check"); return }
    setStatus("sending")
    fetch("/api/send-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientEmail: input.value.trim(), answers, turnstileToken: token })
    }).then((response) => {
      if (response.ok) { setStatus("sent"); return }
      setStatus(response.status === 429 ? "ratelimited" : "error")
    }).catch(() => setStatus("error")).then(resetWidget)
  }

  const messages = {
    sent: ["success", "Your report was sent. Check your inbox, and your spam folder if it does not appear."],
    error: ["error", "We could not send your report. Please try again later, or use Print Action Plan instead."],
    ratelimited: ["error", "Too many reports have been requested. Please try again later, or use Print Action Plan instead."],
    invalid: ["error", "Please enter a valid email address."],
    check: ["error", "Please complete the check above before sending."],
    unavailable: ["error", "Email is unavailable right now. Please use Print Action Plan instead."]
  }
  const message = messages[status]
  return h("section", { className: "card", "data-no-print": "true", "aria-labelledby": "email-title" },
    h("h2", { id: "email-title" }, "Email my report"),
    key
      ? h("form", { className: "stack-sm", onSubmit: submit, noValidate: true },
        h("div", { className: "field" },
          h("label", { className: "label", htmlFor: "report-email" }, "Email address"),
          h("input", { id: "report-email", ref: inputRef, type: "email", name: "email", autoComplete: "email", inputMode: "email", "aria-describedby": "email-disclosure" })),
        h("div", { className: "turnstile-box", ref: boxRef }),
        h("p", { className: "note", id: "email-disclosure" },
          "Your assessment is calculated in your browser. If you choose Email My Report, your email address and answers are sent to our server, which builds the report and sends it through our email provider (Resend), only for report delivery. A Cloudflare Turnstile check helps block automated abuse. ",
          h("a", { href: "/privacy" }, "Privacy notice"), "."),
        h("div", { className: "btn-row" },
          h(Button, { type: "submit", disabled: status === "sending" || !ready }, status === "sending" ? "Sending…" : "Email My Report")),
        message ? h("p", { className: message[0], role: message[0] === "error" ? "alert" : "status" }, message[1]) : null)
      : h("p", { className: "note" }, "Email delivery is not switched on yet. Please use Print Action Plan instead."))
}

// ---- Action plan -----------------------------------------------------------------------------

const Plan = ({ result, answers, ai, setAudience, onGenerate, onReview, onRestart, headingRef }) => {
  const count = result.actions.length
  const title = count === 3 ? "Your three priority actions" : "Your priority actions"
  return h("div", { className: "stack" },
    h("h1", { ref: headingRef, tabIndex: -1 }, title),
    count
      ? h("p", { className: "lead" }, "These actions are based on the practices you answered No, Not sure or Partly, most serious first.")
      : h("p", { className: "headline" }, result.headline),
    result.actions.map((action, index) =>
      h("section", { key: action.id, className: "card priority", "aria-label": `Priority ${index + 1}` },
        h("div", { className: "top" }, h("span", { className: "eyebrow" }, `Priority ${index + 1}`), h("span", { className: "tag" }, action.area)),
        h("h2", null, action.title),
        h("p", null, h("span", { className: "italic-label" }, "Why it matters — "), action.why),
        h("p", null, h("span", { className: "italic-label" }, "First practical step — "), action.first))),
    h("p", { className: "note" }, REVIEW_LINE),
    count ? h(AiAdvisor, { ai, setAudience, onGenerate }) : null,
    h(EmailCard, { answers }),
    h(NextSteps),
    h("div", { className: "btn-row", "data-no-print": "true" },
      h(Button, { onClick: onReview }, "Review my answers"),
      h(Button, { onClick: onRestart }, "Start a new assessment"),
      h(Button, { onClick: () => window.print() }, "Print Action Plan")),
    h("p", { className: "note" }, DISCLAIMER))
}

// ---- app --------------------------------------------------------------------------------------

const App = () => {
  const [state, setState] = useState(loadState)
  const [returnToReview, setReturnToReview] = useState(false)
  const [notice, setNotice] = useState("")
  const [announce, setAnnounce] = useState("")
  const [ai, setAi] = useState({ audience: "business-owner", status: "idle", result: null })
  const aiBusy = useRef(false)
  const aiToken = useRef(0)
  const headingRef = useRef(null)
  const firstRender = useRef(true)

  const { screen, qIndex, answers } = state
  const complete = answers.every((answer) => answer !== null)
  const result = complete ? assess(answers) : null
  const firstOpen = answers.findIndex((answer) => answer === null)

  useEffect(() => { saveState(state) }, [state])
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return }
    window.scrollTo(0, 0)
    headingRef.current?.focus()
  }, [screen, qIndex])
  useEffect(() => {
    if (!result) return
    if (screen === "results") setAnnounce(`Your result: ${result.score} out of ${result.maxScore}. ${result.headline}`)
    else if (screen === "plan") setAnnounce(`Your action plan has ${result.actions.length} priority ${result.actions.length === 1 ? "action" : "actions"}.`)
  }, [screen])

  const resetAi = () => {
    aiToken.current += 1
    aiBusy.current = false
    setAi((previous) => ({ ...previous, status: "idle", result: null }))
  }
  const go = (next, extra = {}) => { setNotice(""); setState((previous) => ({ ...previous, screen: next, ...extra })) }

  const setAnswer = (value) => {
    setNotice("")
    setState((previous) => ({ ...previous, answers: previous.answers.map((answer, index) => (index === previous.qIndex ? value : answer)) }))
    resetAi()
  }
  const next = () => {
    if (answers[qIndex] === null) { setNotice("Please select an answer before continuing."); return }
    if (returnToReview) { setReturnToReview(false); go("review"); return }
    if (qIndex < QUESTION_COUNT - 1) go("assessment", { qIndex: qIndex + 1 })
    else go("review")
  }
  const back = () => {
    if (returnToReview) { setReturnToReview(false); go("review"); return }
    if (qIndex > 0) go("assessment", { qIndex: qIndex - 1 })
    else go("home")
  }
  const calculate = () => {
    if (!complete) { setNotice("Please answer every question before calculating your results."); return }
    go("results")
  }
  const restart = () => {
    clearSaved()
    resetAi()
    setReturnToReview(false)
    setState(blank())
    setNotice("")
    setAnnounce("")
  }
  const clearAnswers = () => {
    restart()
    setAnnounce("Your saved answers have been cleared.")
  }

  const generateAi = () => {
    if (aiBusy.current || !result || result.actions.length === 0) return
    aiBusy.current = true
    const token = ++aiToken.current
    const audience = ai.audience
    const local = result
    setAi((previous) => ({ ...previous, status: "sending", result: null }))
    fetch("/api/ai-guidance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers, audience }) })
      // A bodyless 429 must be handled before any JSON parsing.
      .then((response) => {
        if (response.status === 429) return { kind: "ratelimited" }
        if (!response.ok) return { kind: "error" }
        return response.json().then((json) => ({ kind: "json", json }), () => ({ kind: "error" }))
      })
      .then((out) => {
        if (token !== aiToken.current) return
        if (out.kind === "ratelimited") setAi((previous) => ({ ...previous, status: "ratelimited", result: null }))
        else if (out.kind === "json") {
          const checked = checkAdvisor(out.json, local, audience)
          setAi((previous) => (checked ? { ...previous, status: "done", result: checked } : { ...previous, status: "error", result: null }))
        } else setAi((previous) => ({ ...previous, status: "error", result: null }))
      })
      .catch(() => { if (token === aiToken.current) setAi((previous) => ({ ...previous, status: "error", result: null })) })
      .then(() => { if (token === aiToken.current) aiBusy.current = false })
  }

  let body
  if (screen === "assessment") {
    body = h(Question, { index: qIndex, answers, notice, onAnswer: setAnswer, onBack: back, onNext: next, headingRef })
  } else if (screen === "review") {
    body = h(Review, {
      answers, notice, headingRef, onBack: () => go("assessment", { qIndex: firstOpen === -1 ? QUESTION_COUNT - 1 : firstOpen }),
      onEdit: (index) => { setReturnToReview(true); go("assessment", { qIndex: index }) }, onCalculate: calculate
    })
  } else if ((screen === "results" || screen === "plan") && result) {
    body = screen === "results"
      ? h(Results, { result, headingRef, onPlan: () => go("plan"), onReview: () => go("review"), onClear: clearAnswers })
      : h(Plan, {
        result, answers, ai, headingRef, onGenerate: generateAi, onReview: () => go("review"), onRestart: restart,
        setAudience: (audience) => { if (!aiBusy.current) setAi((previous) => ({ ...previous, audience, status: "idle", result: null })) }
      })
  } else {
    body = h(Home, { headingRef, onStart: () => { setReturnToReview(false); go("assessment", { qIndex: Math.max(0, firstOpen) }) } })
  }

  return h(Fragment, null, body, h("div", { className: "sr-only", role: "status", "aria-live": "polite" }, announce))
}

ReactDOM.createRoot(document.getElementById("root")).render(h(App))
