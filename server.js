const express = require('express');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const {
  FIREFLIES_API_KEY,
  ANTHROPIC_API_KEY,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  NOTIFY_EMAIL,
  SERVER_URL = 'https://profit-assessment-server.up.railway.app',
  ADMIN_PASSWORD = 'changeme'
} = process.env;

// ── Auth helpers ─────────────────────────────────────────────────────────────

function getAuthToken() {
  return crypto.createHash('sha256').update(ADMIN_PASSWORD + 'rh-salt').digest('hex');
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function requireAuth(req, res, next) {
  if (parseCookies(req).rh_auth === getAuthToken()) return next();
  res.redirect('/login');
}

// ── HTML templates ────────────────────────────────────────────────────────────

const STYLES = `
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
  .wrap { max-width: 560px; margin: 60px auto; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
  .header { background: #1A2744; padding: 28px 36px; }
  .header h1 { color: #C8A951; margin: 0; font-size: 20px; letter-spacing: 0.5px; }
  .header p { color: #a0aac0; margin: 4px 0 0; font-size: 13px; }
  .body { padding: 36px; }
  label { display: block; font-size: 13px; font-weight: bold; color: #1A2744; margin-bottom: 6px; margin-top: 20px; }
  label:first-of-type { margin-top: 0; }
  input[type=text], input[type=password], select { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; color: #333; }
  input[type=text]:focus, input[type=password]:focus, select:focus { outline: none; border-color: #1A2744; }
  .btn { display: inline-block; margin-top: 28px; width: 100%; box-sizing: border-box; background: #1A2744; color: #C8A951; padding: 13px; border: none; border-radius: 4px; font-size: 15px; font-weight: bold; cursor: pointer; text-align: center; }
  .btn:hover { background: #243660; }
  .error { background: #fff0f0; border: 1px solid #f5c6cb; color: #721c24; padding: 10px 14px; border-radius: 4px; font-size: 13px; margin-bottom: 20px; }
  .footer { text-align: center; padding: 16px; font-size: 12px; color: #aaa; background: #fafafa; border-top: 1px solid #eee; }
  #other-wrap { display: none; margin-top: 10px; }
`;

function loginPage(error) {
  return `<!DOCTYPE html><html><head><title>Revenue Hounds — Login</title><style>${STYLES}</style></head><body>
  <div class="wrap">
    <div class="header"><h1>Revenue Hounds</h1><p>JumpStart 30 Profit Assessment System</p></div>
    <div class="body">
      ${error ? `<div class="error">${error}</div>` : ''}
      <form method="POST" action="/login">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="Enter your password" autofocus required>
        <button class="btn" type="submit">Sign In</button>
      </form>
    </div>
    <div class="footer">Revenue Hounds Profit Assessment System</div>
  </div>
</body></html>`;
}

function adminPage(success) {
  const industries = [
    'Law Firm', 'Accounting Firm', 'Medical Practice', 'Dental Practice',
    'Financial Planning', 'Real Estate Agency', 'Insurance', 'Consulting',
    'Construction', 'Retail', 'Restaurant / Hospitality', 'Other'
  ];
  return `<!DOCTYPE html><html><head><title>Revenue Hounds — Pre-Call Prep</title><style>${STYLES}
  .success { background: #f0fff4; border: 1px solid #b2dfdb; color: #1b5e20; padding: 10px 14px; border-radius: 4px; font-size: 13px; margin-bottom: 20px; }
  </style></head><body>
  <div class="wrap">
    <div class="header"><h1>Revenue Hounds</h1><p>JumpStart 30 — Pre-Call Interview Guide</p></div>
    <div class="body">
      ${success ? `<div class="success">Guide requested. Check your email in approximately 60 seconds.</div>` : ''}
      <form method="GET" action="/prep">
        <label for="client">Client Name</label>
        <input type="text" id="client" name="client" placeholder="e.g. John Smith" required>
        <label for="company">Company / Firm Name</label>
        <input type="text" id="company" name="company" placeholder="e.g. Smith &amp; Associates">
        <label for="industry">Industry</label>
        <select id="industry" name="industry" onchange="document.getElementById('other-wrap').style.display=this.value==='Other'?'block':'none'" required>
          <option value="">— Select industry —</option>
          ${industries.map(i => `<option value="${i}">${i}</option>`).join('')}
        </select>
        <div id="other-wrap">
          <input type="text" id="industry-other" name="industry_other" placeholder="Describe the industry">
        </div>
        <button class="btn" type="submit" onclick="handleSubmit(event)">Generate Interview Guide</button>
      </form>
    </div>
    <div class="footer"><a href="/logout" style="color:#aaa;text-decoration:none">Sign out</a> &nbsp;·&nbsp; Revenue Hounds Profit Assessment System</div>
  </div>
  <script>
    function handleSubmit(e) {
      const other = document.getElementById('industry-other');
      const sel = document.getElementById('industry');
      if (sel.value === 'Other' && other.value.trim()) {
        sel.value = other.value.trim();
      }
    }
  </script>
</body></html>`;
}

// ── Gmail transport ──────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD
  }
});

// ── Fireflies: fetch transcript ──────────────────────────────────────────────

async function fetchTranscript(meetingId) {
  const response = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIREFLIES_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: `query GetTranscript($id: String!) {
        transcript(id: $id) {
          title
          sentences { raw_text }
        }
      }`,
      variables: { id: meetingId }
    })
  });

  const data = await response.json();
  const transcript = data?.data?.transcript;
  if (!transcript) throw new Error('Transcript not found for meeting ID: ' + meetingId);

  const text = transcript.sentences.map(s => s.raw_text).join(' ');
  return { title: transcript.title || 'Profit Assessment', text };
}

// ── Claude: generate pre-call interview guide ────────────────────────────────

async function generateInterviewGuide(clientName, companyName, industry) {
  const prompt = `Do not use emojis. Do not use markdown formatting — no #, ##, **, or similar symbols. Write in plain professional text only, using capitalised section headings and clear paragraph breaks.

You are a senior business profit consultant preparing for a 30-minute JumpStart 30 Profit Assessment session with a prospective client. The JumpStart 30 system identifies small, compounding improvements across 12 profit levers to produce measurable profit increases within 30 days.

Client name: ${clientName || 'Not specified'}
Company / Firm name: ${companyName || 'Not specified'}
Industry: ${industry}

Your job is to prepare a targeted pre-call interview guide that will make the most of 30 minutes. The questions should be tailored specifically to the realities, terminology, and profit patterns of the ${industry} industry. Do not use generic business questions — every question should feel like it came from someone who deeply understands this sector.

The guide should feel like a seasoned consultant's personal call sheet, not a form. You are diagnosing a business, not completing a survey.

Structure the guide as follows:


PRE-CALL CONTEXT
A brief paragraph (3-4 sentences) on what typically drives profit problems in the ${industry} industry. The common patterns: where revenue hides, where margin leaks, what owners in this space typically overlook. This frames your mindset before the call begins.


OPENING (2-3 minutes)
3-4 questions to open the conversation, build rapport, and establish context. These should feel conversational. Focus on why they started the business, how long they have been at it, what role they play day-to-day, and where they want to be in 5 years.


FINANCIAL BASELINE (5-7 minutes)
5-6 questions to establish the numbers. Tailor these to the ${industry} industry — use the right terminology for revenue, margins, and cost structures in this sector. You need annual revenue, gross profit margin, and net profit margin at minimum. If they do not know their margins, probe for enough data to estimate them. Also ask about revenue trend over the past 3 years.


THE 12 LEVER ASSESSMENT (15-18 minutes)
For each of the 12 profit levers below, provide 1-3 targeted questions specific to the ${industry} industry. These should surface both what they are currently doing and the size of the opportunity. Do not ask textbook questions — ask the questions a sharp consultant would ask after years of working in this sector.

Lever 1: Cut Costs — where is overhead hiding, what has never been renegotiated, what processes create waste
Lever 2: Market-Dominating Position — how do they differentiate, what do clients say when they refer them, do they own a niche
Lever 3: Compelling Offer — what is their main offer, does it include a risk reversal, what makes it hard to say no to
Lever 4: Increase Prices — when did they last raise prices, how do they position value, what would happen if they charged 10% more
Lever 5: Upsell and Cross-Sell — what else do clients need that they are not currently buying from them
Lever 6: Bundling — what services could be packaged together at a higher perceived value
Lever 7: Downsell — what happens when a prospect says the price is too high, do they have a lower-entry offer
Lever 8: Additional Products and Services — what adjacent services do clients frequently ask for or go elsewhere to get
Lever 9: Drip Campaign — how do they follow up with prospects who did not buy, how many touches before they give up
Lever 10: Alliances and Joint Ventures — who else serves their ideal client before or after them, any formal referral relationships
Lever 11: More Leads — what is their primary lead source, how predictable is it, what would double their leads
Lever 12: Digital Marketing — website, social presence, lead generation online, reviews and reputation


CLOSING (2-3 minutes)
2-3 questions to close the assessment well. What are the 3 biggest problems they face right now? What would a 20% increase in profit mean for them personally? What is stopping them from growing faster?


CONSULTANT REMINDERS
3-5 brief notes to yourself about what to listen for in a ${industry} business — the signals that indicate whether profit problems are structural vs behavioural, whether the owner is ready to move, and what objections to expect.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (!data?.content?.[0]?.text) throw new Error('Claude returned no content: ' + JSON.stringify(data));
  return data.content[0].text;
}

// ── Claude: analyse transcript ───────────────────────────────────────────────

async function analyseTranscript(transcriptText) {
  const prompt = `Do not use emojis. Do not use markdown formatting — no #, ##, **, or similar symbols. Write in plain professional text only, using capitalised section headings and clear paragraph breaks.

You are a senior business profit consultant trained in the JumpStart 30 system — a methodology that identifies small, compounding improvements across 12 profit levers to produce measurable profit increases within 30 days. A prospect has just completed a Profit Assessment session. You are preparing your internal working notes — a structured consultant briefing that will inform the client-facing Profit Acceleration Report.

Write with the confidence of someone who has run this analysis hundreds of times. Be direct, specific, and candid. If a lever is being ignored entirely, say so. If the opportunity is obvious, name it plainly. Quote the client's own words where they are revealing. This document is for your eyes only — no sugarcoating.

Analyse the transcript below and produce a detailed internal briefing with the following sections:


1. CLIENT OVERVIEW
Client name and business. Industry and approximate size. Your honest first impression of their profit situation in 2-3 sentences. Are they revenue-rich and profit-poor? Plateaued? Leaving obvious money on the table? Call it what it is.


2. FINANCIAL BASELINE
Extract every financial figure mentioned: annual revenue, gross profit margin (GPM), net profit margin (NPM), and current net profit in dollars (calculate if not stated directly). Compare their GPM and NPM against typical industry averages for their sector. Note whether they are above, at, or below average — and what that means for the conversation. If figures were not given, note what was said and flag the gap.


3. BUSINESS VALUATION SNAPSHOT
Based on what was discussed: revenue trend (growing/steady/declining), recurring revenue percentage, scalability, documentation of systems and processes, customer concentration risk, and whether they have accountant-prepared financials. Give a brief read on how this business would look to a buyer — and what that implies about the owner's real options.


4. THE 12 LEVER ASSESSMENT
Assess each of the 12 profit levers based on what was said in the interview. For each lever, provide:
- Current state: what they are doing now (or not doing)
- Opportunity rating: Low / Medium / High
- Realistic improvement estimate: a specific percentage achievable within 90 days with focused effort
- Dollar impact: calculated against their stated (or estimated) revenue baseline
- Key quote or observation from the transcript, if available

The 12 levers are:
Lever 1: Cut Costs
Lever 2: Market-Dominating Position
Lever 3: Compelling Offer
Lever 4: Increase Prices
Lever 5: Upsell and Cross-Sell
Lever 6: Bundling
Lever 7: Downsell
Lever 8: Additional Products and Services
Lever 9: Drip Campaign
Lever 10: Alliances and Joint Ventures
Lever 11: More Leads
Lever 12: Digital Marketing

Be industry-specific in your assessment. If this is a law firm, frame each lever in terms of billable hours, matter types, client retention, referral networks, and fee structures. If it is a different industry, apply the same specificity. Generic observations are useless here.


5. PROFIT ACCELERATION PROJECTION
Using the financial baseline and the improvement estimates from Section 4, calculate the compounded profit impact of implementing the top levers. Show your working clearly:

- Current annual revenue
- Current net profit (dollars)
- Lever improvements applied (list each lever used and its % improvement)
- How the compounding works: each lever multiplies on top of the previous, not adds
- Projected new annual profit (dollars)
- Total profit increase (dollars and percentage)

Note: improvements do not all need to be large. The power is in simultaneous compounding. This business does not need to double its revenue — it needs to move multiple small dials at the same time.


6. PRIORITY ACTION PLAN
The 3-5 levers with the highest impact-to-effort ratio for this specific client. Sequence them: what to attack first, second, third. For each, state why it ranks here and what the first concrete action would be.


7. CONSULTANT NOTES
Your private read on the client and the conversation. Buying signals, hesitations, objections raised, emotional drivers, and anything that should shape how you position the Profit Acceleration Report and the follow-on simulator session. Be completely candid — this is your internal debrief.


TRANSCRIPT:
${transcriptText}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (!data?.content?.[0]?.text) throw new Error('Claude returned no content: ' + JSON.stringify(data));
  return data.content[0].text;
}

// ── Claude: generate Profit Acceleration Report ──────────────────────────────

async function generateReport(analysisText) {
  const prompt = `Do not use emojis. Do not use markdown formatting — no #, ##, **, or similar symbols. Write in plain professional text only, using capitalised section headings and clear paragraph breaks.

You are a senior business profit consultant preparing a client-facing Profit Acceleration Report following a JumpStart 30 Profit Assessment session. The JumpStart 30 system identifies small, compounding improvements across 12 profit levers to produce measurable profit increases within 30 days.

Using the internal analysis below, write a professional, authoritative report for the client. The tone should feel like a senior advisor who has diagnosed their situation precisely — confident, warm, and specific. The client should feel deeply understood, not processed. Every sentence should earn its place. No corporate filler. No vague promises.

This is not a sales document. It is a diagnostic report. The numbers do the persuading.

Structure the report as follows:


JUMPSTART 30 PROFIT ACCELERATION REPORT
Prepared by Revenue Hounds
Unlock the profit already inside your firm.


EXECUTIVE SUMMARY
2-3 paragraphs. Name the core finding directly: this business has more profit available inside it than it is currently capturing. State what the assessment revealed — the specific gap between where they are and where the numbers say they could be. Frame the opportunity in dollar terms, not percentages. Close with a single sentence positioning the next step.


YOUR CURRENT POSITION
A precise, empathetic summary of where this business stands today. Use their actual numbers. Compare them to industry averages where relevant. Name the pattern plainly — whether that is revenue that has plateaued, margins thinner than they should be, or profit that has not kept pace with revenue growth. Make the client feel that you were paying close attention — because you were. Use the phrase naturally if it fits: working harder, earning the same, keeping less.


THE PROFIT ALREADY INSIDE YOUR BUSINESS
Introduce the JumpStart 30 methodology in plain language. The core insight: most businesses focus entirely on generating new revenue. But for every dollar of new revenue, you keep only the margin. For every dollar of profit recovered through smarter strategy, you keep the whole dollar. Small, simultaneous improvements across 12 levers do not add — they compound. Reference the compounding principle briefly: what feels like a series of modest changes produces a dramatically different number when all 12 levers move at once. What follows is a lever-by-lever assessment of where that compounding is available in this specific business.


LEVER-BY-LEVER ASSESSMENT
For each of the 12 levers where there is a substantive observation to make, write a short paragraph (3-5 sentences) covering:
- What the lever is, explained plainly in the context of their specific industry
- What the assessment revealed about their current state in this area
- The specific opportunity available
- A realistic improvement estimate and its dollar impact

Only include levers where something meaningful was discussed or observed. Omit levers where there is nothing substantive to say. Quality over completeness.


THE COMPOUNDED OPPORTUNITY
Present the profit acceleration projection in a clear, readable format. Show:
- Current annual revenue
- Current net profit
- The levers being applied and their individual improvement estimates
- The compounded result: projected new annual profit
- Total profit increase in dollars

Then write 2-3 sentences explaining why this number is achievable. It does not require a single breakthrough — just consistent movement across multiple levers simultaneously. This is the section the client will read twice.


YOUR 30-DAY PROFIT ROADMAP
A practical 30/60/90 day plan. Quick wins in the first 30 days, momentum-building in the second, structural changes in the third. Frame it as a sequence of moves, not a checklist. Each phase should have a clear, tangible outcome the client can picture.


NEXT STEP
One paragraph. Invite the client to a 30-minute Profit Acceleration Simulator session where you plug in their real numbers and show the compounded profit growth on screen — live, using their actual figures. No cost. No obligation. It is the natural continuation of this assessment: they have seen the analysis, the simulator shows the live numbers.

Close with: "To book your Profit Acceleration Simulator session, reply to this email. It takes 30 minutes and uses your real numbers. The profit is already there — the simulator shows you exactly where."


INTERNAL ANALYSIS:
${analysisText}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (!data?.content?.[0]?.text) throw new Error('Claude returned no content: ' + JSON.stringify(data));
  return data.content[0].text;
}

// ── In-memory store for pending assessments ──────────────────────────────────
// Maps meetingId -> { title, transcript, analysis }
const assessmentStore = {};

// ── Routes ───────────────────────────────────────────────────────────────────

// ── Auth routes ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (parseCookies(req).rh_auth === getAuthToken()) return res.redirect('/admin');
  res.redirect('/login');
});

app.get('/login', (req, res) => res.send(loginPage()));

app.post('/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.setHeader('Set-Cookie', `rh_auth=${getAuthToken()}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect('/admin');
  }
  res.send(loginPage('Incorrect password. Please try again.'));
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'rh_auth=; HttpOnly; Path=/; Max-Age=0');
  res.redirect('/login');
});

app.get('/admin', requireAuth, (req, res) => {
  res.send(adminPage(req.query.success === '1'));
});

// Pre-call prep: GET /prep?client=Name&industry=law+firm
app.get('/prep', requireAuth, async (req, res) => {
  const { client, company, industry } = req.query;

  if (!industry) return res.redirect('/admin');

  // Redirect back immediately so the user sees the success state
  res.redirect('/admin?success=1');

  const label = [client, company ? `(${company})` : ''].filter(Boolean).join(' ');
  console.log(`Pre-call prep requested: client=${label || 'not specified'}, industry=${industry}`);

  try {
    const guide = await generateInterviewGuide(client, company, industry);

    await transporter.sendMail({
      from: GMAIL_USER,
      to: NOTIFY_EMAIL,
      subject: `Pre-Call Interview Guide — ${industry}${label ? ` · ${label}` : ''}`,
      html: `
        <p><strong>Your JumpStart 30 pre-call interview guide is ready.</strong></p>
        ${client ? `<p><strong>Client:</strong> ${client}</p>` : ''}
        ${company ? `<p><strong>Company:</strong> ${company}</p>` : ''}
        <p><strong>Industry:</strong> ${industry}</p>
        <hr>
        <pre style="font-family:Arial;font-size:14px;white-space:pre-wrap">${guide}</pre>
        <hr>
        <br><p style="color:#888">Revenue Hounds Profit Assessment System</p>
      `
    });

    console.log(`Pre-call guide emailed for industry: ${industry}`);
  } catch (err) {
    console.error('Pre-call prep error:', err.message);
  }
});

// Phase 1: Fireflies webhook fires when meeting is transcribed
app.post('/webhook/fireflies', async (req, res) => {
  res.sendStatus(200); // acknowledge immediately

  const meetingId = req.body.meeting_id || req.body.meetingId;
  if (!meetingId) {
    console.error('No meeting_id in webhook payload:', req.body);
    return;
  }

  console.log('Phase 1: Received webhook for meeting:', meetingId);

  try {
    const { title, text } = await fetchTranscript(meetingId);
    assessmentStore[meetingId] = { title, transcript: text, analysis: null };

    console.log('Phase 1: Transcript fetched for:', title);

    await transporter.sendMail({
      from: GMAIL_USER,
      to: NOTIFY_EMAIL,
      subject: `JumpStart 30 Assessment for ${title} is Ready`,
      html: `
        <p><strong>A new JumpStart 30 Profit Assessment transcript is ready.</strong></p>
        <p><strong>Client:</strong> ${title}</p>
        <p><strong>Transcript length:</strong> ${text.split(' ').length} words</p>
        <p><strong>Meeting ID:</strong> ${meetingId}</p>
        <p>When you are ready to run the profit analysis, click the button below:</p>
        <p><a href="${SERVER_URL}/analyse/${meetingId}" style="background:#1A2744;color:#C8A951;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px">Generate Profit Analysis</a></p>
        <br><p style="color:#888">Revenue Hounds Profit Assessment System</p>
      `
    });

    console.log('Phase 1: Notification email sent for:', title);
  } catch (err) {
    console.error('Phase 1 error:', err.message);
  }
});

// Phase 2: GET — click the link in the Phase 1 email
app.get('/analyse/:meetingId', async (req, res) => {
  res.send(`<html><body style="font-family:Arial;padding:40px;max-width:600px">
    <h2 style="color:#1A2744">Generating profit analysis...</h2>
    <p>The JumpStart 30 assessment is running across all 12 profit levers. You will receive an email with the full internal briefing in approximately 60 seconds.</p>
    <p style="color:#888">Revenue Hounds Profit Assessment System</p>
  </body></html>`);

  const { meetingId } = req.params;
  const assessment = assessmentStore[meetingId];
  if (!assessment) {
    console.error('Phase 2 GET: No assessment found for meeting:', meetingId);
    return;
  }

  try {
    const analysis = await analyseTranscript(assessment.transcript);
    assessmentStore[meetingId].analysis = analysis;

    await transporter.sendMail({
      from: GMAIL_USER,
      to: NOTIFY_EMAIL,
      subject: `Profit Analysis for ${assessment.title} is Ready`,
      html: `
        <p><strong>Your JumpStart 30 Profit Analysis is complete.</strong></p>
        <p><strong>Client:</strong> ${assessment.title}</p>
        <p><strong>Meeting ID:</strong> ${meetingId}</p>
        <hr>
        <pre style="font-family:Arial;font-size:14px;white-space:pre-wrap">${analysis}</pre>
        <hr>
        <p>When you are ready to generate the client-facing Profit Acceleration Report, click below:</p>
        <p><a href="${SERVER_URL}/report/${meetingId}" style="background:#1A2744;color:#C8A951;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px">Generate Profit Acceleration Report</a></p>
        <br><p style="color:#888">Revenue Hounds Profit Assessment System</p>
      `
    });

    console.log('Phase 2 GET: Analysis email sent for:', assessment.title);
  } catch (err) {
    console.error('Phase 2 GET error:', err.message);
  }
});

// Phase 2: POST — backwards-compatible
app.post('/analyse/:meetingId', async (req, res) => {
  res.sendStatus(200);

  const { meetingId } = req.params;
  const assessment = assessmentStore[meetingId];

  if (!assessment) {
    console.error('Phase 2 POST: No assessment found for meeting:', meetingId);
    return;
  }

  console.log('Phase 2 POST: Running analysis for:', assessment.title);

  try {
    const analysis = await analyseTranscript(assessment.transcript);
    assessmentStore[meetingId].analysis = analysis;

    await transporter.sendMail({
      from: GMAIL_USER,
      to: NOTIFY_EMAIL,
      subject: `Profit Analysis for ${assessment.title} is Ready`,
      html: `
        <p><strong>Your JumpStart 30 Profit Analysis is complete.</strong></p>
        <p><strong>Client:</strong> ${assessment.title}</p>
        <p><strong>Meeting ID:</strong> ${meetingId}</p>
        <hr>
        <pre style="font-family:Arial;font-size:14px;white-space:pre-wrap">${analysis}</pre>
        <hr>
        <p><a href="${SERVER_URL}/report/${meetingId}" style="background:#1A2744;color:#C8A951;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:4px">Generate Profit Acceleration Report</a></p>
        <br><p style="color:#888">Revenue Hounds Profit Assessment System</p>
      `
    });

    console.log('Phase 2 POST: Analysis email sent for:', assessment.title);
  } catch (err) {
    console.error('Phase 2 POST error:', err.message);
  }
});

// Phase 3: GET — click the link in the Phase 2 email
app.get('/report/:meetingId', async (req, res) => {
  res.send(`<html><body style="font-family:Arial;padding:40px;max-width:600px">
    <h2 style="color:#1A2744">Generating Profit Acceleration Report...</h2>
    <p>The client-facing JumpStart 30 report is being written. You will receive an email in approximately 60 seconds.</p>
    <p style="color:#888">Revenue Hounds Profit Assessment System</p>
  </body></html>`);

  const { meetingId } = req.params;
  const assessment = assessmentStore[meetingId];
  if (!assessment || !assessment.analysis) {
    console.error('Phase 3 GET: No analysis found for meeting:', meetingId);
    return;
  }

  try {
    const report = await generateReport(assessment.analysis);

    await transporter.sendMail({
      from: GMAIL_USER,
      to: NOTIFY_EMAIL,
      subject: `Profit Acceleration Report for ${assessment.title} is Ready`,
      html: `
        <p><strong>The client-facing JumpStart 30 Profit Acceleration Report is complete.</strong></p>
        <p><strong>Client:</strong> ${assessment.title}</p>
        <hr>
        <pre style="font-family:Arial;font-size:14px;white-space:pre-wrap">${report}</pre>
        <hr>
        <p>Review and edit before sending to the client.</p>
        <br><p style="color:#888">Revenue Hounds Profit Assessment System</p>
      `
    });

    console.log('Phase 3 GET: Report email sent for:', assessment.title);
  } catch (err) {
    console.error('Phase 3 GET error:', err.message);
  }
});

// Phase 3: POST — backwards-compatible
app.post('/report/:meetingId', async (req, res) => {
  res.sendStatus(200);

  const { meetingId } = req.params;
  const assessment = assessmentStore[meetingId];

  if (!assessment || !assessment.analysis) {
    console.error('Phase 3 POST: No analysis found for meeting:', meetingId);
    return;
  }

  console.log('Phase 3 POST: Generating report for:', assessment.title);

  try {
    const report = await generateReport(assessment.analysis);

    await transporter.sendMail({
      from: GMAIL_USER,
      to: NOTIFY_EMAIL,
      subject: `Profit Acceleration Report for ${assessment.title} is Ready`,
      html: `
        <p><strong>The client-facing JumpStart 30 Profit Acceleration Report is complete.</strong></p>
        <p><strong>Client:</strong> ${assessment.title}</p>
        <hr>
        <pre style="font-family:Arial;font-size:14px;white-space:pre-wrap">${report}</pre>
        <hr>
        <p>Review and edit before sending to the client.</p>
        <br><p style="color:#888">Revenue Hounds Profit Assessment System</p>
      `
    });

    console.log('Phase 3 POST: Report email sent for:', assessment.title);
  } catch (err) {
    console.error('Phase 3 POST error:', err.message);
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`JumpStart 30 Profit Assessment Server listening on port ${PORT}`));
