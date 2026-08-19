// THE MARK IS SEVERAL SMALL CALLS, NOT ONE ENORMOUS ONE (19 Aug 2026).
//
// markLikeMarker used to be a single call that wrote the whole mark. On
// Sarah's 7HR02 (CIPD Level 7, 4,713 words, four criteria) that was 26,577
// output tokens in 262 seconds at high effort — and a hollow answer at medium.
// It is now an ORCHESTRATION: one OVERALL call, then one call per criterion,
// all in flight together off a byte-identical (so cached) system prompt, and
// merged in code into the exact shape normaliseMark has always been handed.
//
// Orchestration breaks silently, and you cannot afford to re-verify it by
// paying for a real 4,700-word mark every time somebody edits a prompt. So
// this test swaps the model layer out at the seam (__setAccurateForTests) and
// proves the wiring for nothing: NO MODEL IS CALLED BY THIS TEST, ever.
//
// The stub answers are the REAL 7HR02 mark, split back into the pieces the
// two calls now return — same brief, same four criteria, same nine critique
// items, same LO marks — so the merge is judged against a mark that actually
// happened rather than a shape somebody invented.
//
// Run:  node tests/writer-mark-split.test.js
// Exits 0 on ALL PASS, 1 otherwise.
'use strict';

const qw = require('../plugins/q-writer');

let failed = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failed++; };
const section = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 68 - t.length)));

// The real mark, as it came back on 19 Aug 2026 (brief + normalised mark).
const FIXTURE = {
 "brief": {
  "scenario": null,
  "title": "7HR02 Resourcing and Talent Management to Sustain Success — Assessment Questions",
  "subject": "CIPD Level 7 Advanced Diploma in Strategic People Management",
  "docType": "essay",
  "whatItWants": "OK so you need to write four evaluated, evidence-based answers about your own organisation's employer brand, selection technology, retention interventions and performance management approach, each tied to a real example from your workplace.",
  "youreProducing": "A written assignment of around 4,290 words split into four sections, each answering one question and drawing on your own organisation for evidence and examples.",
  "wordCount": "4290",
  "deadline": null,
  "criteria": [
   {
    "id": "AC1.4",
    "label": "Employer brand and EVP",
    "text": "Critically evaluate your organisation's employer brand and make recommendations on how this can be improved to ensure a more compelling employee value proposition, securing an enhanced reputation in the labour market.",
    "weight": null,
    "wordBudget": 1070
   },
   {
    "id": "AC2.3",
    "label": "Technology in selection",
    "text": "Critically analyse how technologies can be utilised to improve employee selection, drawing upon examples to illustrate.",
    "weight": null,
    "wordBudget": 1070
   },
   {
    "id": "AC3.3",
    "label": "Retention interventions",
    "text": "Recommend two interventions that could be designed to improve the retention of staff, justifying why they are appropriate to your organisation.",
    "weight": null,
    "wordBudget": 1070
   },
   {
    "id": "AC4.1",
    "label": "Managing performance fairly",
    "text": "Drawing upon research evidence, provide a justified argument for the adoption of collaborative as opposed to punitive approaches to managing and enhancing employee performance.",
    "weight": null,
    "wordBudget": 1070
   }
  ],
  "gradeBands": {
   "top": "A top answer names what your organisation actually does (its brand messaging, selection tools, turnover figures, performance process), weighs it critically against research evidence and named models, and ends each section with a specific, justified recommendation rather than a general one.",
   "mid": "A mid answer describes what your organisation does and mentions relevant theory or evidence, but doesn't fully weigh the strengths against the weaknesses or link recommendations tightly to your organisation's own situation.",
   "low": "A low answer describes employer branding, selection, retention or performance management in general terms without anchoring the discussion in your own organisation's facts, figures or actual practice."
  },
  "idealAnswerSkeleton": [
   {
    "criterionId": "AC1.4",
    "keyPoints": [
     "Define employer brand and the employee value proposition (EVP) — what the organisation offers in return for what it asks of employees, e.g. pay, culture, development, flexibility.",
     "Give a real picture of your organisation's current employer brand — how it presents itself externally (careers site, reviews on Glassdoor/Indeed, social media, employee referrals) and internally (culture as experienced by staff).",
     "Critically evaluate this — where does the stated EVP match or fail to match what employees actually experience day to day? Use any evidence you have — exit interview themes, engagement survey scores, glassdoor ratings, recruitment difficulty in certain roles.",
     "Bring in a labour market angle — is the organisation competing for talent in a tight market, and does its reputation help or hurt that?",
     "Reference a recognised model (e.g. Barrow and Mosley's employer brand concept, or CIPD's EVP framework) to frame the evaluation, not just describe it.",
     "Make specific, justified recommendations — not generic ('improve communication') but tied to a named gap you've identified, and explain what improved reputation would look like in practice."
    ]
   },
   {
    "criterionId": "AC2.3",
    "keyPoints": [
     "Name the technologies actually used or usable in selection: applicant tracking systems, psychometric/situational judgement testing, video interviewing, AI-driven CV screening, gamified assessments.",
     "Give a concrete example from your own organisation or a comparable one — which technology is used, for which roles, and what it replaced.",
     "Critically analyse benefits: efficiency, consistency, reduced bias claims, wider reach to candidates.",
     "Critically analyse risks: algorithmic bias, loss of human judgement, candidate experience concerns, adverse impact on certain groups, data protection issues (e.g. GDPR).",
     "Weigh the evidence — cite research or reported findings on effectiveness (e.g. studies on AI screening bias) rather than just asserting pros and cons.",
     "Conclude with a balanced judgement on how technology should be used in selection — not replacing but supporting human decision-making."
    ]
   },
   {
    "criterionId": "AC3.3",
    "keyPoints": [
     "State the retention problem in your organisation with real evidence — turnover rate, which roles or groups leave most, cost of replacing them.",
     "Choose two distinct interventions (e.g. career pathways/development programme, flexible working, improved reward/recognition, better line manager training, mentoring) — not two versions of the same thing.",
     "For each, explain the mechanism — why it should reduce turnover, linking to a retention theory (e.g. psychological contract, job embeddedness, or Herzberg's hygiene/motivator factors).",
     "Justify appropriateness specifically to your organisation — its workforce profile, sector, budget realities, culture — not a generic case for the intervention.",
     "Anticipate implementation challenges (cost, manager buy-in, time to show results) and briefly address them.",
     "Show awareness of how success would be measured (e.g. reduced turnover in target group, engagement scores) to demonstrate a justified, evaluative recommendation."
    ]
   },
   {
    "criterionId": "AC4.1",
    "keyPoints": [
     "Define collaborative versus punitive approaches to performance management — collaborative being ongoing dialogue, coaching, joint goal-setting; punitive being disciplinary-led, backward-looking, focused on blame.",
     "Bring in research evidence — e.g. work on performance management reform (Pulakos, Aguinis, CIPD research on ditching forced ranking) showing collaborative approaches improve engagement and performance outcomes.",
     "Give or construct an example — how a punitive approach plays out (e.g. poor performance triggers formal warnings immediately) versus a collaborative one (regular check-ins, support plans) and the likely different outcomes.",
     "Address counterarguments — punitive approaches can seem necessary for accountability or in cases of misconduct; acknowledge where some structure or consequence still matters.",
     "Build a justified argument, not just a description, for why collaborative approaches better serve performance and retention, tying back to evidence.",
     "Link the conclusion back to organisational context — what adopting this approach would mean practically for managers in your organisation."
    ]
   }
  ],
  "opener": "Think of a job advert or company page that actually made you want to apply somewhere — what was it about that company that appealed to you?",
  "prerequisites": [
   "Details of your own organisation's current employer brand messaging (careers site, job adverts, any employee reviews such as Glassdoor)",
   "Any turnover, retention or exit interview data your organisation holds",
   "Information on the selection methods and technology your organisation currently uses in recruitment",
   "Details of how performance is currently managed at your organisation (appraisal process, disciplinary process, any recent changes)"
  ]
 },
 "mark": {
  "overall": {
   "band": "mid",
   "label": "Merit",
   "summary": "All four answers use real organisational evidence and are genuinely engaged with, but three of the four never name the theory or framework that explains WHY the recommendation should work, which is what is holding this at Merit rather than Distinction.",
   "strong": [
    "the three-strike rule case study with real productivity and turnover figures",
    "LinkedIn Recruiter cost-benefit calculation showing agency fee savings",
    "Herzberg and Dan Pink correctly named and applied to your own production department",
    "real living wage recommendation tied to your own salary benchmarking data"
   ],
   "missing": [
    "no named retention theory linking either Q3 intervention to why it works",
    "GDPR or data protection risk never mentioned alongside the Equality Act point",
    "CIPD's 2016 performance management report sits unused in the bibliography",
    "own organisation's brand evidence crowded out by the Apple example at the start"
   ],
   "answeredCount": 4,
   "nextLabel": "Distinction",
   "toNext": "Name a retention theory (Herzberg's hygiene factors or the psychological contract) for each Q3 intervention, bring the CIPD 'Could do better?' report into the Q4 argument, and lead Q1 with your own organisation's Glassdoor or careers-page evidence before using Apple as a one-line comparison.",
   "ladder": [
    {
     "label": "Distinction",
     "needs": [
      "Name a retention theory (Herzberg's hygiene factors or the psychological contract) explaining why each Q3 intervention should reduce turnover.",
      "Add implementation challenges and a specific success measure (a number and timeframe) for both Q3 interventions.",
      "Apply a structured EVP framework, such as CIPD's, point-by-point to your own organisation's brand evidence rather than leading with Apple.",
      "Bring the CIPD 'Could do better?' report into Q4 and a GDPR/data-protection point into Q2 to widen the reading actually used in the text."
     ]
    }
   ],
   "loMarks": [
    {
     "label": "LO1",
     "mark": 3,
     "reason": "Focus and strategic application are good — the answer addresses the EVP question directly using Walker's model, exit interview data and specific recommendations tied to percentage figures, but the opening spends real estate on Apple rather than the organisation's own reputation evidence, and no structured EVP framework such as CIPD's is applied point-by-point, so it falls short of 'excellent breadth and depth of analysis' needed for Distinction."
    },
    {
     "label": "LO2",
     "mark": 3,
     "reason": "Strategic application is strong — the LinkedIn Recruiter cost-benefit calculation and named technologies show solid, well-informed advice, and research citations (CIPD, Mohdzaini, Tan) give a good standard of in-text referencing, but the weighing of evidence relies on a single case study rather than a spread of sources, keeping research and wider reading at 'good' rather than 'excellent'."
    },
    {
     "label": "LO3",
     "mark": 2,
     "reason": "Focus is an adequate attempt — both interventions are stated directly with real turnover and exit-interview data — but depth and breadth of analysis is limited: neither intervention is linked to a named retention theory, implementation challenges are not addressed and success measures are vague, which caps this at Pass rather than Merit."
    },
    {
     "label": "LO4",
     "mark": 3,
     "reason": "Persuasiveness and originality are strong — the three-strike rule case study with real quantified before-and-after figures is excellent use of examples, and Herzberg and Pink are correctly named and applied with good breadth and depth of analysis — but collaborative management is never defined as a concept the way punitive is, and the CIPD performance-management-reform report already in the bibliography is unused in the text, so research and wider reading stays at 'good' rather than 'excellent'."
    }
   ],
   "total": 11,
   "structure": "Your headings name the AC number for each question (e.g. 'Question 1 (AC 1.4)') but never the Learning Outcome number itself — add 'LO1', 'LO2' and so on alongside them so the assessor can map the marks straight away.",
   "scheme": {
    "id": "cipd-l7",
    "name": "CIPD Level 7 Advanced Diploma",
    "labels": [
     "Refer",
     "Pass",
     "Merit",
     "Distinction"
    ]
   }
  },
  "perCriterion": [
   {
    "criterionId": "AC1.4",
    "band": "top",
    "label": "Merit",
    "voicedBrickIds": [],
    "termsUsed": [],
    "requirementsMet": [],
    "evidence": "our benefits are very structured and offering flexible benefits would give employees the variety our broad, diverse employee group needs",
    "got": [
     "you quoted Walker's definition of employer brand and EVP correctly",
     "real exit interview and benefits data referenced from your own organisation",
     "specific recommendations tied to percentage figures from exit interviews",
     "used SWOT and STEEPLE analysis to frame your conclusion"
    ],
    "addNext": [
     {
      "title": "Name a proper EVP model",
      "gap": "You use Walker's definition but never apply a structured framework to score your own EVP element by element.",
      "concept": "CIPD's EVP framework breaks the 'offer' into parts — reward, opportunity, people, work, organisation — so you can say exactly where the offer is strong and where it's thin, rather than describing it in general terms.",
      "prompt": "Write two or three sentences scoring your organisation against these categories, citing the CIPD factsheet already in your bibliography.",
      "example": "Using this framework, Company X scores well on 'reward' but weakly on 'opportunity', showing candidates a strong pay message but a thin career story."
     },
     {
      "title": "Cut the Apple detour, centre your own brand",
      "gap": "The opening spends several sentences on Apple's careers messaging when the question asks about your own organisation's brand.",
      "concept": "External examples work best as a short one-line comparator, not the leading example — the assessor wants your own careers page, Glassdoor rating or referral numbers discussed first.",
      "prompt": "Write two or three sentences on what your own careers page, social media or Glassdoor reviews actually say, then use Apple only as a brief comparison afterwards.",
      "example": "TechCo's 3.2-star Glassdoor rating exposes a gap between its stated 'innovation-first' EVP and reviews citing outdated processes."
     },
     {
      "title": "Bring in the labour market picture",
      "gap": "You cite McKinsey's career-attribute data but never say whether your sector's labour market is tight or loose right now.",
      "concept": "When skilled candidates are scarce, employer reputation becomes the deciding factor between competing offers — that's the labour market angle a Level 7 answer needs.",
      "prompt": "Add one or two sentences stating whether your sector currently has a skills shortage and what that means for how hard you must work on your EVP.",
      "example": "With conveyancing search analysts in short supply nationally, a firm's reputation increasingly decides which candidates accept an offer over a rival's."
     }
    ],
    "missingForTop": "Walker's definition is quoted but never tested against a structured EVP framework such as CIPD's, and the Apple example crowds out a fuller picture of the organisation's own external reputation before the recommendations are made.",
    "nextQuestion": "If a friend searched your company on Glassdoor tonight, what's the very first review they'd probably read?"
   },
   {
    "criterionId": "AC2.3",
    "band": "top",
    "label": "Merit",
    "voicedBrickIds": [],
    "termsUsed": [],
    "requirementsMet": [],
    "evidence": "our talent manager would have to make an average of 7 direct hires in 12 months for us to cover the cost of LinkedIn recruiter",
    "got": [
     "named LinkedIn Recruiter, AI screening, ATS and video interviewing all in use",
     "worked out the real cost saving of direct hires versus agency fees",
     "quoted CIPD survey data on rising technology use since the pandemic",
     "flagged the Equality Act 2010 risk from filtering criteria"
    ],
    "addNext": [
     {
      "title": "Weigh the AI bias evidence, not just report it",
      "gap": "You quote Tan (2022) that AI can cause indirect discrimination, but never say how big or common that risk is found to be against human decision-making.",
      "concept": "Studies of algorithmic screening — like Amazon's scrapped CV tool that downgraded women's applications — show bias can be baked into training data silently, and can be harder to spot than one biased interviewer.",
      "prompt": "Add two or three sentences comparing the scale of AI's risk to human bias, citing one more source specifically on this comparison.",
      "example": "Where one interviewer's bias affects a handful of decisions, a flawed algorithm can silently disadvantage thousands of applications before anyone notices the pattern."
     },
     {
      "title": "Name the wider human-vs-machine research",
      "gap": "Your evidence is mostly one case (Mohdzaini's organisation); wider reading means more than a single example.",
      "concept": "Look for a second source comparing structured technology-led selection to unstructured human judgement, or use CIPD's own resourcing survey data you've already cited elsewhere.",
      "prompt": "Add one sentence bringing in a second source on selection technology's overall effectiveness, not just Mohdzaini's single case.",
      "example": "Broader survey data suggests most employers report faster hiring after adopting new technology, but fewer report equal gains in decision quality."
     },
     {
      "title": "Add GDPR to the risk list",
      "gap": "You cover Equality Act 2010 risk fully but say nothing about what happens to candidate data once LinkedIn, AI or an ATS processes it.",
      "concept": "UK data protection law requires organisations to be able to explain how automated decisions about candidates are reached — a real risk if an ATS auto-rejects someone without explanation.",
      "prompt": "Write one sentence naming this data protection risk alongside your Equality Act point, tied to your own ATS or LinkedIn use.",
      "example": "Where an ATS auto-screens applications, the employer must also be able to show candidates how that automated decision was reached, under data protection law."
     }
    ],
    "missingForTop": "The risks section covers discrimination law well but never mentions data protection, and the evidence used to weigh benefits against risks is a single case study rather than a spread of research.",
    "nextQuestion": "If your system auto-rejects someone's application, could you tell them exactly why the computer said no?"
   },
   {
    "criterionId": "AC3.3",
    "band": "mid",
    "label": "Pass",
    "voicedBrickIds": [],
    "termsUsed": [],
    "requirementsMet": [],
    "evidence": "a staggering 48% referenced salary as a contributor",
    "got": [
     "gave the real turnover figures and exit interview percentages driving this",
     "chose two genuinely different interventions: pay and training",
     "linked the real living wage to a marketing benefit for recruitment",
     "worked out the pound-figure saving if training stopped people leaving"
    ],
    "addNext": [
     {
      "title": "Name the theory behind why pay stops people leaving",
      "gap": "You show pay data and recommend a real living wage but never say why money keeps people, in theory terms.",
      "concept": "Herzberg's theory (which you use later, in Q4) calls pay a 'hygiene factor' — if it's too low people leave, but raising it only removes dissatisfaction, it doesn't create loyalty on its own, which is why pay rises alone often only work for a while.",
      "prompt": "Write two or three sentences naming this hygiene factor idea here, explaining why the salary uplift needs pairing with something else, like the training programme you recommend, to hold people longer-term.",
      "example": "A pay rise at Firm Y stopped the immediate exodus, but within a year turnover crept back up because nothing else about the role had changed."
     },
     {
      "title": "Name what training is trying to fix, psychologically",
      "gap": "Your training recommendation is well evidenced with cost figures but doesn't say why training keeps people beyond stopping complaints.",
      "concept": "The 'psychological contract' is the unwritten deal employees feel they have with an employer — things like being invested in and given a future. When training is missing, that unwritten deal feels broken, which drives people to leave even if pay is fine.",
      "prompt": "Write one or two sentences naming the psychological contract and linking it to your training gap, using your 28% exit-interview figure as the evidence.",
      "example": "When a new starter is promised development but never receives it, the unwritten deal they signed up to is broken, and job adverts elsewhere start to look more attractive."
     },
     {
      "title": "Say what could go wrong bringing these in",
      "gap": "Both recommendations are costed and justified but you never say what might slow them down or make managers resist.",
      "concept": "Any new benefit or training programme needs manager time and budget sign-off; a common real obstacle is line managers not prioritising training delivery when workload is high.",
      "prompt": "Add two or three sentences naming one practical obstacle for each recommendation, cost approval for the salary uplift and manager time for delivering training, and how you'd address it.",
      "example": "Even with board approval, if regional managers see training as time away from targets, sessions get cancelled — so completion needs to be built into manager KPIs."
     },
     {
      "title": "Say how you'll know it worked",
      "gap": "You show a past example where a salary increase reduced complaints, but never set out how you'll measure success for the current recommendations.",
      "concept": "A justified recommendation states the number you'll track and the target — for example, cutting entry-level turnover from one percentage to another within a set period.",
      "prompt": "Write one sentence for each intervention stating the specific figure you'll monitor and over what timeframe.",
      "example": "Success would look like exit-interview mentions of training dropping from 28% to under 15% within the next annual cycle."
     }
    ],
    "missingForTop": "Neither intervention is linked to a named retention theory explaining why it should reduce turnover, and there's no discussion of what could go wrong implementing them or how success will be measured going forward.",
    "nextQuestion": "In twelve months, what one number would you check to prove the training programme actually worked?"
   },
   {
    "criterionId": "AC4.1",
    "band": "top",
    "label": "Merit",
    "voicedBrickIds": [],
    "termsUsed": [],
    "requirementsMet": [],
    "evidence": "94% of the new starters showed a decrease in searches per day",
    "got": [
     "gave a real quantified before-and-after example: the three-strike rule and its fallout",
     "named Herzberg's hygiene and motivator factors correctly",
     "brought in Dan Pink's autonomy, mastery and purpose",
     "acknowledged that some employees still need formal, stronger measures"
    ],
    "addNext": [
     {
      "title": "Define collaborative properly, not just by contrast",
      "gap": "You define punitive plainly but collaborative is only ever shown through your own experience, never defined as a concept.",
      "concept": "Collaborative performance management means ongoing two-way conversations, joint goal-setting and coaching rather than a once-a-year judgement — manager and employee build the plan together instead of the manager handing down a verdict.",
      "prompt": "Write one sentence defining collaborative management this way, before your Herzberg discussion, so both sides of the argument are properly set up.",
      "example": "Rather than a manager delivering a verdict at a single annual review, a collaborative approach means agreeing goals and check-ins together throughout the year."
     },
     {
      "title": "Bring in research on ditching punitive performance systems",
      "gap": "Your bibliography lists CIPD's 'Could do better?' report on performance management reform, but it's never used in the text.",
      "concept": "CIPD's research found many organisations are dropping punitive, forced-ranking style appraisals because they harm trust and engagement without improving performance — a directly relevant finding you already have to hand.",
      "prompt": "Add one sentence citing this CIPD report specifically, alongside your Kohn quote, to show wider reading beyond one author.",
      "example": "Wider sector research has found organisations abandoning forced-ranking appraisal systems once they see the damage to trust outweighs any performance gain."
     },
     {
      "title": "Tighten the counterargument with a real limit",
      "gap": "You accept that punitive measures are sometimes needed for disengaged staff, but don't say where that line sits.",
      "concept": "Most collaborative-approach advocates still accept a role for formal process in cases of misconduct or after repeated, documented support has failed — the disagreement is about what happens before that point, not whether structure ever matters.",
      "prompt": "Add one sentence making clear that a collaborative approach doesn't rule out formal steps, only that they come after genuine support has been tried and failed.",
      "example": "Even organisations built around coaching still move to formal process once documented support hasn't shifted performance after a fair period."
     }
    ],
    "missingForTop": "Collaborative management is shown through examples but never defined as a concept the way punitive is, and the CIPD research on performance management reform sitting in your bibliography is never actually used in the argument.",
    "nextQuestion": "Before the three-strikes rule kicked in, did a manager ever just sit down and talk it through first?"
   }
  ],
  "weakestCriterionId": "AC3.3",
  "critique": [
   {
    "sentence": "One recommendation within my Organisation is to increase the base salaries of the lower-level roles, using the real living wage as a guide.",
    "missing": "No theory says why pay stops people leaving.",
    "fix": "Name Herzberg's hygiene factor idea here.",
    "targetBrickId": null,
    "suggestedTools": [
     "terminology",
     "strategies"
    ],
    "needs": [
     "theory"
    ],
    "criterionId": "AC3.3"
   },
   {
    "sentence": "The second recommendation would be to implement a training program, not only for the managers but also for their senior team members.",
    "missing": "No theory ties training to people staying.",
    "fix": "Name the psychological contract idea here.",
    "targetBrickId": null,
    "suggestedTools": [
     "terminology",
     "strategies"
    ],
    "needs": [
     "theory"
    ],
    "criterionId": "AC3.3"
   },
   {
    "sentence": "In conclusion, we are doing a lot of the push factors detailed above well, so I see minimal changes required to these at this time.",
    "missing": "No number set to check this worked.",
    "fix": "Add the figure and timeframe you'll track.",
    "targetBrickId": null,
    "suggestedTools": [
     "strategies"
    ],
    "needs": [
     "other"
    ],
    "criterionId": "AC3.3"
   },
   {
    "sentence": "Apple's EVP is an excellent display of marketing; it is attention-grabbing and automatically makes the reader feel accepted.",
    "missing": "This is Apple's brand, not yours yet.",
    "fix": "Add what your own careers page or Glassdoor actually says.",
    "targetBrickId": null,
    "suggestedTools": [
     "cases",
     "weak"
    ],
    "needs": [
     "example"
    ],
    "criterionId": "AC1.4"
   },
   {
    "sentence": "A benefit is only a benefit if the employee believes it is, and therefore, offering a variety of flexible benefits will only enhance our EVP, offering the right benefits to attract the target demographic.",
    "missing": "No named model behind this claim.",
    "fix": "Apply CIPD's EVP framework categories to this point.",
    "targetBrickId": null,
    "suggestedTools": [
     "terminology",
     "references"
    ],
    "needs": [
     "theory"
    ],
    "criterionId": "AC1.4"
   },
   {
    "sentence": "Utilising this technology also has some pitfalls, such as not giving every applicant an equal opportunity for their application, which could be part of the Equality Act 2010 and lead to a tribunal.",
    "missing": "Equality Act named, but data protection isn't.",
    "fix": "Add one sentence on GDPR/data protection risk here.",
    "targetBrickId": null,
    "suggestedTools": [
     "terminology",
     "references"
    ],
    "needs": [
     "statute"
    ],
    "criterionId": "AC2.3"
   },
   {
    "sentence": "Although there are huge time and cost-saving benefits to utilising AI, there is also an argument that this depersonalises the process.",
    "missing": "One case, no wider evidence on scale.",
    "fix": "Bring in a second source on AI bias scale.",
    "targetBrickId": null,
    "suggestedTools": [
     "references",
     "cases"
    ],
    "needs": [
     "citation",
     "reference"
    ],
    "criterionId": "AC2.3"
   },
   {
    "sentence": "The definition of punitive is punishment, and as a business, the employer should never want to punish their employees.",
    "missing": "Punitive is defined, collaborative never properly is.",
    "fix": "Add one sentence defining collaborative management.",
    "targetBrickId": null,
    "suggestedTools": [
     "terminology",
     "dictionary"
    ],
    "needs": [
     "theory"
    ],
    "criterionId": "AC4.1"
   },
   {
    "sentence": "Although not all of the above can be directly linked to using collaborative measures rather than the punitive ones we had in place, as we have introduced several changes on the back of the employee survey, there is strong evidence that this had a big part to play.",
    "missing": "Your CIPD reform report is never used here.",
    "fix": "Cite the CIPD 'Could do better?' report right here.",
    "targetBrickId": null,
    "suggestedTools": [
     "references"
    ],
    "needs": [
     "citation",
     "reference"
    ],
    "criterionId": "AC4.1"
   }
  ]
 }
};
const BRIEF = FIXTURE.brief;
const MARK = FIXTURE.mark;
const IDS = BRIEF.criteria.map(c => c.id);          // AC1.4, AC2.3, AC3.3, AC4.1

// A draft to mark: her own sentences (the ones the real critique quotes),
// plus a reference list, so the numbered-draft builder does real work.
const DOC = MARK.critique.map(c => c.sentence).join(' ')
    + '\n\nReferences\n'
    + 'CIPD (2024) Resourcing and talent planning survey. London: CIPD.\n'
    + 'Herzberg, F. (1968) One more time: how do you motivate employees? Harvard Business Review, 46(1), pp. 53-62.\n';

// ── the stub ────────────────────────────────────────────────────────────────
// Answers in the shape each call's schema asks for, cut from the real mark.
const overallAnswer = () => { const { scheme, ...overall } = MARK.overall; return { overall, weakestCriterionId: MARK.weakestCriterionId }; };
const criterionAnswer = (id) => {
    const { criterionId, ...entry } = MARK.perCriterion.find(p => p.criterionId === id);
    return { ...entry, critique: MARK.critique.filter(c => c.criterionId === id).map(({ criterionId: _drop, ...it }) => it) };
};

const TICK = () => new Promise(r => setTimeout(r, 12));

// Every call the orchestration makes is recorded; per-criterion calls hold the
// lock for a real timer tick, so "how many were in flight at once" is measured,
// not assumed.
function harness(answer) {
    const calls = [];
    const state = { inFlight: 0, maxInFlight: 0 };
    const fn = async (system, user, opts) => {
        const kind = opts && opts.schema === qw.OVERALL_MARK_SCHEMA ? 'overall'
            : opts && opts.schema === qw.CRITERION_MARK_SCHEMA ? 'criterion' : 'unknown';
        const m = /THE CRITERION YOU ARE MARKING: \[([^\]]+)\]/.exec(String(user || ''));
        const rec = { kind, id: m ? m[1] : null, system: String(system || ''), user: String(user || ''), opts: opts || {} };
        calls.push(rec);
        if (kind === 'criterion') { state.inFlight++; state.maxInFlight = Math.max(state.maxInFlight, state.inFlight); }
        try {
            await TICK();
            return await answer(rec, calls);
        } finally {
            if (kind === 'criterion') state.inFlight--;
        }
    };
    return { fn, calls, state };
}

async function runMark(answer, over = {}) {
    const h = harness(answer);
    qw.__setAccurateForTests(h.fn);
    try {
        const r = await qw.markLikeMarker({
            brief: BRIEF, essay: null, docText: DOC,
            gradeScheme: 'CIPD Level 7', plans: null, taskText: 'CIPD_7HR02_24_01', ...over,
        });
        return { r, ...h };
    } finally { qw.__setAccurateForTests(null); }
}

const DEFAULT = (rec) => rec.kind === 'overall' ? overallAnswer() : criterionAnswer(rec.id);

(async () => {

// ── 1. the fan-out, and it really is parallel ───────────────────────────────
section('one overall call, one per criterion, in parallel');
const A = await runMark(DEFAULT);
{
    const per = A.calls.filter(c => c.kind === 'criterion');
    ok(A.calls.length === 1 + IDS.length, `${1 + IDS.length} calls in total, not one enormous one — made ${A.calls.length}`);
    ok(A.calls.filter(c => c.kind === 'overall').length === 1, 'exactly one OVERALL call');
    ok(per.length === IDS.length, `one call per criterion (${per.length} of ${IDS.length})`);
    ok(JSON.stringify(per.map(c => c.id).sort()) === JSON.stringify(IDS.slice().sort()), 'and it is one call for EACH criterion: ' + per.map(c => c.id).join(', '));
    ok(A.state.maxInFlight > 1, `the per-criterion calls really overlap — max in flight was ${A.state.maxInFlight}`);
    ok(A.state.maxInFlight <= 4, `and never more than four at once — max in flight was ${A.state.maxInFlight}`);
    ok(A.calls.every(c => c.opts.maxTokens === 12000), 'every call is a SMALL one: maxTokens 12000 (was 32000 for the single call)');
    ok(A.calls.every(c => c.opts.timeoutMs === 180000), 'every call gets 180s, well inside the 420s the page waits');
    ok(A.calls.every(c => c.opts.effort === 'medium'), 'every call runs at medium effort on the happy path');
    ok(A.calls.every(c => !('response_format' in c.opts)), 'no call is given response_format — the schema goes through the `schema` option only');
    ok(A.calls.every(c => c.opts.schema && c.opts.schema.type === 'object'), 'every call carries its JSON schema');
}

// ── 2. the caching requirement ──────────────────────────────────────────────
section('every per-criterion system prompt is byte-identical');
{
    const per = A.calls.filter(c => c.kind === 'criterion');
    const first = per[0].system;
    ok(per.every(c => c.system === first), 'all four per-criterion system prompts are byte-for-byte the same string');
    ok(per.every(c => Buffer.byteLength(c.system) === Buffer.byteLength(first)), `same byte length (${Buffer.byteLength(first)} bytes) — the cached prefix cannot differ`);
    // The system prompt cannot be checked for "does not contain AC1.4" — it
    // carries THE BRIEF, which lists every criterion by id, and must. What
    // matters is that it never says WHICH ONE this call is marking: that line
    // lives in the user message only, and byte-identity proves no per-call
    // difference of any kind leaked into the cached half.
    ok(per.every(c => !/THE CRITERION YOU ARE MARKING/.test(c.system)), 'the system prompt never names the criterion being marked (that line is in the user message)');
    ok(per.every(c => new RegExp('THE CRITERION YOU ARE MARKING: \\[' + c.id.replace('.', '\\.') + '\\]').test(c.user)), 'each USER message names its own criterion, first thing');
    ok(per.every(c => c.user.includes("STUDENT'S DRAFT")), 'each per-criterion call is given the WHOLE draft — a student answers where they like');
    ok(per.every(c => c.user.includes('REFERENCE LIST')), 'and the reference list as a list, not as sentences');
    ok(/THE MARKING STANDARD/.test(first), 'the cached half carries the published standard (CIPD L7 grid)');
    ok(/THE BRIEF/.test(first) && /CRITERIA \(in writing order\)/.test(first), 'and the brief — the big stable block worth caching');
    ok(A.calls.find(c => c.kind === 'overall').system !== first, 'the overall call has its own prompt (it is not marking a question)');
}

// ── 3. the merge, through the real normaliseMark ────────────────────────────
section('the merged mark is the shape the page has always been given');
{
    const r = A.r;
    ok(Object.keys(r).join(',') === 'overall,perCriterion,weakestCriterionId,critique', 'top-level shape unchanged: ' + Object.keys(r).join(','));
    ok(r.perCriterion.length === 4, `four questions come back (${r.perCriterion.length})`);
    ok(r.perCriterion.every(p => p.band !== 'missing'), 'all four are GRADED — none fell through to "not started"');
    ok(JSON.stringify(r.perCriterion.map(p => p.criterionId)) === JSON.stringify(IDS), 'in the brief\'s own order: ' + r.perCriterion.map(p => p.criterionId).join(', '));
    ok(JSON.stringify(r.perCriterion.map(p => p.label)) === JSON.stringify(['Merit', 'Merit', 'Pass', 'Merit']), 'with the real grades: ' + r.perCriterion.map(p => p.label).join(', '));
    ok(r.perCriterion.every(p => p.evidence && p.got.length && p.addNext.length), 'each carries its evidence, what they got, and what to add next');
    ok(r.overall.loMarks.length === 4, `four learning-outcome marks (${r.overall.loMarks.length})`);
    ok(r.overall.total === 11, `the total is the sum of them: ${r.overall.total}`);
    ok(r.overall.label === 'Merit', `the CIPD table's unit result: ${r.overall.label} (3+3+2+3 = 11 → Merit)`);
    ok(r.overall.band === 'mid' && r.overall.nextLabel === 'Distinction', 'band mid, next grade up Distinction');
    ok(r.overall.ladder.length >= 1 && r.overall.ladder.every(x => x.needs.length), 'the ladder survives: ' + r.overall.ladder.map(x => x.label).join(' → '));
    ok(r.overall.ladder.every(x => x.label === 'Distinction'), 'and only rungs ABOVE the grade given remain');
    ok(r.overall.scheme && r.overall.scheme.id === 'cipd-l7', 'the published scheme is named on the mark');
    ok(r.weakestCriterionId === 'AC3.3', 'the weakest question is carried over from the overall call: ' + r.weakestCriterionId);
    ok(r.overall.summary && r.overall.strong.length && r.overall.missing.length, 'the overall summary, what stays and what is missing all survive');
}

section('the critique: every question\'s items, weakest first then document order');
{
    const r = A.r;
    ok(r.critique.length === 9, `nine items, the same nine the real mark had (${r.critique.length})`);
    ok(JSON.stringify(r.critique.map(c => c.criterionId)) === JSON.stringify(['AC3.3', 'AC3.3', 'AC3.3', 'AC1.4', 'AC1.4', 'AC2.3', 'AC2.3', 'AC4.1', 'AC4.1']),
        'weakest (AC3.3, the only Pass) first, then document order: ' + r.critique.map(c => c.criterionId).join(' '));
    ok(r.critique.every(c => c.sentence && (c.missing || c.fix)), 'each item still quotes her sentence and says what to do');
    ok(r.critique.every(c => DOC.includes(c.sentence)), 'and every quoted sentence is verbatim from the draft');
}

// ── 4. code is truth: the arithmetic overrides the model ────────────────────
section('the CIPD arithmetic overrides whatever grade the model wrote');
{
    const B = await runMark((rec) => {
        if (rec.kind !== 'overall') return criterionAnswer(rec.id);
        const a = overallAnswer();
        return { ...a, overall: { ...a.overall, label: 'Distinction', band: 'top', total: 99, nextLabel: '' } };
    });
    ok(B.r.overall.label === 'Merit', 'the model said "Distinction"; the published table says Merit — the table wins');
    ok(B.r.overall.total === 11, `and the total is recomputed from the LO marks: ${B.r.overall.total}`);
    ok(B.r.overall.band === 'mid' && B.r.overall.nextLabel === 'Distinction', 'band and next grade follow the table');
}
{
    // The model left the LO marks out entirely — they are derived from the
    // question grades and SAID to be derived (Sarah's live mark, 18 Aug).
    const C = await runMark((rec) => {
        if (rec.kind !== 'overall') return criterionAnswer(rec.id);
        const a = overallAnswer();
        return { ...a, overall: { ...a.overall, loMarks: [], total: 0 } };
    });
    ok(C.r.overall.loMarks.length === 4, `no loMarks from the model → four derived from the question grades (${C.r.overall.loMarks.length})`);
    ok(C.r.overall.loMarks.every(x => x.derived), 'each is flagged derived, with the working in its reason');
    ok(C.r.overall.label === 'Merit', 'and the unit result still lands on Merit');
}

// ── 5. one question falls over; the mark does not ──────────────────────────
section('one criterion throwing does not lose the mark');
{
    const D = await runMark((rec) => {
        if (rec.kind === 'overall') return overallAnswer();
        if (rec.id === 'AC2.3') throw new Error('Claude upstream 529: overloaded');
        return criterionAnswer(rec.id);
    });
    const r = D.r;
    ok(r.perCriterion.length === 4, 'all four questions are still on the mark');
    ok(r.perCriterion.filter(p => p.band !== 'missing').length === 3, 'three are graded');
    const gone = r.perCriterion.find(p => p.criterionId === 'AC2.3');
    ok(gone && gone.band === 'missing' && /Nothing in the document addresses this criterion yet/.test(gone.missingForTop), 'the one that failed is filled in by normaliseMark, not dropped');
    ok(r.critique.every(c => c.criterionId !== 'AC2.3') && r.critique.length === 7, `its critique items are gone with it (${r.critique.length} left)`);
    ok(r.overall.label === 'Merit', 'the overall grade still stands');
}

// ── 6. a hollow overall: one retry, then an honest throw ───────────────────
section('a hollow overall is retried once at high effort, then said honestly');
{
    const hollow = { overall: { band: 'low', label: '', summary: '', strong: [], missing: [], answeredCount: 0, nextLabel: '', toNext: '', ladder: [], loMarks: [], total: 0, structure: '' }, weakestCriterionId: '' };
    const h = harness((rec) => rec.kind === 'overall' ? hollow : criterionAnswer(rec.id));
    qw.__setAccurateForTests(h.fn);
    let threw = null;
    try { await qw.markLikeMarker({ brief: BRIEF, essay: null, docText: DOC, gradeScheme: 'CIPD Level 7', plans: null, taskText: 'CIPD_7HR02_24_01' }); }
    catch (e) { threw = e; }
    finally { qw.__setAccurateForTests(null); }
    const overalls = h.calls.filter(c => c.kind === 'overall');
    ok(overalls.length === 2, `the overall call is made exactly twice (${overalls.length}) — one retry, not a loop`);
    ok(overalls[0].opts.effort === 'medium' && overalls[1].opts.effort === 'high', 'the retry is at HIGHER effort: ' + overalls.map(c => c.opts.effort).join(' → '));
    ok(h.calls.filter(c => c.kind === 'criterion').length === 0, 'and no money is spent marking the questions once the overall is known to be hollow');
    ok(threw && threw.message === 'The mark came back incomplete twice (the marker graded nothing per question) — try again in a minute.', 'it throws the honest message: ' + (threw && threw.message));
}

// ── 7. every question failing: one retry pass, then the same honest throw ──
section('every question failing is a hollow mark too');
{
    const h = harness((rec) => { if (rec.kind === 'overall') return overallAnswer(); throw new Error('fetch failed'); });
    qw.__setAccurateForTests(h.fn);
    let threw = null;
    try { await qw.markLikeMarker({ brief: BRIEF, essay: null, docText: DOC, gradeScheme: 'CIPD Level 7', plans: null, taskText: 'CIPD_7HR02_24_01' }); }
    catch (e) { threw = e; }
    finally { qw.__setAccurateForTests(null); }
    const per = h.calls.filter(c => c.kind === 'criterion');
    ok(per.length === 8, `every question is tried twice — once at medium, once at high (${per.length} calls for 4 criteria)`);
    ok(per.slice(0, 4).every(c => c.opts.effort === 'medium') && per.slice(4).every(c => c.opts.effort === 'high'), 'the retry pass is at higher effort');
    ok(threw && threw.message === 'The mark came back incomplete twice (the marker graded nothing per question) — try again in a minute.', 'and the same honest message: ' + (threw && threw.message));
}

// ── 8. the caps ────────────────────────────────────────────────────────────
section('MAX_CRITIQUE, and three items per question');
{
    const many = (id) => {
        const base = criterionAnswer(id);
        const one = MARK.critique.find(c => c.criterionId === id);
        const { criterionId: _d, ...it } = one;
        return { ...base, critique: [it, it, it, it, it, it] };   // six from every question = 24
    };
    const E = await runMark((rec) => rec.kind === 'overall' ? overallAnswer() : many(rec.id));
    ok(E.r.critique.length === qw.MAX_CRITIQUE, `24 items offered, ${qw.MAX_CRITIQUE} kept — MAX_CRITIQUE is respected (${E.r.critique.length})`);
    const perQ = {};
    for (const c of E.r.critique) perQ[c.criterionId] = (perQ[c.criterionId] || 0) + 1;
    ok(Object.values(perQ).every(n => n <= 3), 'and no question contributes more than three: ' + JSON.stringify(perQ));
    ok(perQ['AC3.3'] === 3, 'the weakest question gets its full three, first');
}

// ── 9. the guards the route relies on ──────────────────────────────────────
section('the guards are unchanged');
{
    let m1 = '', m2 = '';
    qw.__setAccurateForTests(async () => { throw new Error('the model must not be called'); });
    try { await qw.markLikeMarker({ brief: { criteria: [] }, docText: 'x' }); } catch (e) { m1 = e.message; }
    try { await qw.markLikeMarker({ brief: BRIEF, docText: '   ' }); } catch (e) { m2 = e.message; }
    qw.__setAccurateForTests(null);
    ok(m1 === 'No brief yet — upload the task first.', 'no brief: ' + m1);
    ok(m2 === 'There is nothing on the page to mark yet.', 'nothing on the page: ' + m2);
}

console.log('\n' + (failed ? failed + ' FAILED' : 'ALL PASS') + '  (no model was called by this test)');
process.exit(failed ? 1 : 0);

})().catch(e => { console.error('THREW: ' + (e && e.stack || e)); process.exit(1); });
