// Single source of truth for the assessment: questions, answer values, scoring, action selection
// and results wording. It is a plain ES module with no dependencies. The browser loads it as
// /assessment.js, and the Netlify Functions import it from here, so the page, the email report and
// the AI check can never disagree. Nothing in this file touches the DOM or the network.

export const ANSWER_VALUES = ["yes", "partly", "unsure", "no"]
export const ANSWER_LABELS = { yes: "Yes", partly: "Partly", unsure: "Not sure", no: "No" }
const POINTS = { yes: 2, partly: 1, unsure: 0, no: 0 }

export const NOT_SURE_FIRST_STEP = "Ask your IT provider or check the settings, then answer this question again."

// Each question has one approved action. `topic` completes the "Find out: ..." title that is used
// when the answer is "Not sure".
export const QUESTIONS = Object.freeze([
  {
    id: "mfa", area: "Identity", topic: "MFA for work email",
    text: "Does everyone have to use a second sign-in step (multi-factor authentication, MFA) to open work email?",
    help: "For example a code or an approval on a phone, after entering the password.",
    action: {
      title: "Require MFA for email and administrator accounts.",
      why: "MFA adds protection when a password is stolen.",
      first: "Identify email and administrator accounts that do not require MFA."
    }
  },
  {
    id: "admin-mfa", area: "Administrator sign-in", topic: "MFA for administrators",
    text: "Do the people who manage your IT systems (administrators) also have to use MFA?",
    help: "Administrators can change settings and see everything, so this matters most.",
    action: {
      title: "Require MFA for administrator accounts.",
      why: "Administrator accounts can change settings and see everything, so a stolen password there does the most damage.",
      first: "List every administrator account and turn on MFA for each one."
    }
  },
  {
    id: "admin-accounts", area: "Access", topic: "separate administrator accounts",
    text: "Do administrators use a separate account for administrator work, not the one they use for email and web browsing?",
    help: "Separate accounts limit the damage if an everyday account is tricked.",
    action: {
      title: "Separate administrator accounts from daily-use accounts.",
      why: "Separate accounts reduce unnecessary use of powerful permissions.",
      first: "Identify people who use administrator access for email or normal browsing."
    }
  },
  {
    id: "passwords", area: "Passwords", topic: "password manager use",
    text: "Do staff use a password manager, so each account has its own different password?",
    help: "Saved in a spreadsheet, a notebook or the browser does not count.",
    action: {
      title: "Adopt unique passwords and an approved password manager.",
      why: "Reused passwords allow one stolen password to affect several accounts.",
      first: "Identify shared or reused passwords and select an approved password manager."
    }
  },
  {
    id: "backups", area: "Recovery", topic: "backups and restore testing",
    text: "Are your important files backed up somewhere separate from the computers that hold them, and have you tried restoring one?",
    help: "Answer Partly if backups exist but nobody has tested getting a file back.",
    action: {
      title: "Document backups and complete a controlled restore test.",
      why: "A backup provides value only when the business can restore its information.",
      first: "Select one important file and complete a controlled restore test."
    }
  },
  {
    id: "updates", area: "Updates", topic: "software updates",
    text: "Are computers, browsers and business applications kept up to date, ideally automatically?",
    help: "This includes phones used for work.",
    action: {
      title: "Create a regular update process.",
      why: "Updates correct known security weaknesses and software defects.",
      first: "List business devices and confirm whether automatic updates are enabled."
    }
  },
  {
    id: "endpoint", area: "Devices", topic: "antivirus protection checks",
    text: "Does every business computer run up-to-date antivirus or similar protection that someone checks?",
    help: "For example Microsoft Defender. 'Checks' means someone would notice if a computer had it switched off.",
    action: {
      title: "Enable and monitor endpoint protection.",
      why: "Endpoint protection helps identify and contain malicious activity on business devices.",
      first: "Confirm which devices lack active protection or central monitoring."
    }
  },
  {
    id: "encryption", area: "Data protection", topic: "device encryption",
    text: "Are laptops and other portable business devices encrypted, so a lost device does not expose your files?",
    help: "On Windows this is BitLocker, on Mac it is FileVault.",
    action: {
      title: "Enable full-disk encryption on portable business devices.",
      why: "Encryption reduces data exposure if a device is lost or stolen.",
      first: "Check the encryption status of every business laptop."
    }
  },
  {
    id: "awareness", area: "People", topic: "phishing training",
    text: "Have staff had short, practical training on spotting phishing emails and on how to report one?",
    help: "A short session or video counts, if people know who to tell.",
    action: {
      title: "Provide practical phishing-awareness training.",
      why: "Employees need a clear way to recognize and report suspicious messages.",
      first: "Schedule a short training session and explain how to report suspicious email."
    }
  },
  {
    id: "incident-plan", area: "Response", topic: "an incident response plan",
    text: "Is there a written plan saying who to contact and what to do first if you suspect a hacked account or a scam?",
    help: "One page is enough.",
    action: {
      title: "Create a one-page incident contact and response plan.",
      why: "Clear contacts and first steps reduce confusion during an incident.",
      first: "Document who employees contact when they suspect phishing or account compromise."
    }
  },
  {
    id: "remote-access", area: "Remote access", topic: "limits on remote access",
    text: "If staff can reach business systems from outside the office (for example a VPN or remote desktop), is that limited to approved people?",
    help: "Answer Yes if you do not offer remote access at all.",
    action: {
      title: "Restrict remote access and require MFA.",
      why: "Exposed or weakly protected remote access can provide entry to business systems.",
      first: "List remote-access methods and confirm the approved users and MFA status."
    }
  },
  {
    id: "leavers", area: "Leavers", topic: "same-day access removal for leavers",
    text: "When someone leaves, is their access to email and business systems switched off the same day?",
    help: "This includes shared logins they knew.",
    action: {
      title: "Switch off leavers' access the same day they leave.",
      why: "Old accounts and shared logins that stay active let former staff, or anyone who takes over their login, keep getting in.",
      first: "List everyone who left in the last 12 months and check their accounts."
    }
  },
  {
    id: "sharing", area: "Sharing", topic: "who can open shared files",
    text: "Do you know who outside your business can open your shared files and folders?",
    help: "For example links shared with 'anyone', or customers and suppliers added as guests.",
    action: {
      title: "Review who can open your shared files.",
      why: "Files shared with 'anyone' or with outside guests can be opened by people you never intended.",
      first: "Find links shared with \"anyone\" and remove the ones you do not need."
    }
  }
])

export const QUESTION_COUNT = QUESTIONS.length
export const MAX_SCORE = QUESTION_COUNT * 2
export const MAX_ACTIONS = 3

// Most serious exposure first. Used to choose which actions to show.
export const RISK_ORDER = Object.freeze([
  "mfa", "admin-mfa", "remote-access", "backups", "admin-accounts", "updates", "endpoint",
  "passwords", "leavers", "sharing", "encryption", "awareness", "incident-plan"
])

// A "No" here means the "most practices are in place" wording must never be shown.
export const CRITICAL_IDS = Object.freeze(["mfa", "admin-mfa", "backups"])

export const NUMBER_WORDS = { 13: "thirteen" }

export const DISCLAIMER = "This is educational guidance based only on your answers. It does not inspect your systems or replace a professional security assessment. It is not a vulnerability score, compliance result or audit."
export const REVIEW_LINE = "Review these actions with an appropriate IT or security professional before implementation."

const BAND_TEXT = {
  high: "Your answers indicate that most practices are in place.",
  middle: "Your answers indicate that some practices are in place and others are missing or only partly in place.",
  low: "Your answers indicate that several practices are not yet in place."
}
const CRITICAL_TEXT = "Your answers show at least one important gap. Start with the actions below."
const PERFECT_TEXT = `You answered Yes to all ${NUMBER_WORDS[QUESTION_COUNT]} practices. These are your own answers, not a test of your systems. Repeat this assessment periodically.`

export const isAnswerArray = (value) =>
  Array.isArray(value) && value.length === QUESTION_COUNT && value.every((answer) => ANSWER_VALUES.includes(answer))

// Action shown for one question at one answer level (null for "yes").
export const actionFor = (question, level) => {
  if (level === "yes") return null
  const { id, area } = question
  const { title, why, first } = question.action
  if (level === "unsure") return { id, area, level, title: `Find out: ${question.topic}`, why, first: NOT_SURE_FIRST_STEP }
  return { id, area, level, title, why, first }
}

// Everything derived from a complete, valid answer array. Returns null for anything else.
export const assess = (answers) => {
  if (!isAnswerArray(answers)) return null
  const levelOf = (id) => answers[QUESTIONS.findIndex((question) => question.id === id)]
  const score = answers.reduce((sum, answer) => sum + POINTS[answer], 0)
  const strengths = QUESTIONS.filter((_, index) => answers[index] === "yes")
  const gaps = QUESTIONS.map((question, index) => ({ question, level: answers[index] })).filter(({ level }) => level !== "yes")

  const actions = []
  for (const level of ["no", "unsure", "partly"]) {
    for (const id of RISK_ORDER) {
      if (levelOf(id) !== level) continue
      actions.push(actionFor(QUESTIONS.find((question) => question.id === id), level))
    }
  }

  const percent = (score / MAX_SCORE) * 100
  const band = percent >= 75 ? "high" : percent >= 40 ? "middle" : "low"
  const criticalGap = CRITICAL_IDS.some((id) => levelOf(id) === "no")
  const allYes = gaps.length === 0
  const headline = allYes ? PERFECT_TEXT : criticalGap ? CRITICAL_TEXT : BAND_TEXT[band]
  return { score, maxScore: MAX_SCORE, strengths, gaps, actions: actions.slice(0, MAX_ACTIONS), band, criticalGap, allYes, headline }
}

export const gapLabel = ({ question, level }) => `${question.area} — ${ANSWER_LABELS[level]}`
