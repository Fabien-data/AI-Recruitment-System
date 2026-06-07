# Recruitment System — Upgrades & Changes Log

A running log of system upgrades. Newest decisions at the top of each section.

---

## Session handoff (read this first in a new chat)

**Branch:** `fix/active-jobs-cap-no-dead-end`.

> **✅ PHASE 0 SHIPPED + DEPLOYED + verified on prod (2026-06-07, commit `3285349`).** Items #1 (status standardization), #5 (CV eligibility gate), #2 (role-based access) are live. Prod deploy: backend rev `recruitment-backend-00092-jdq`; chatbot `whatsapp-chatbot-00138-kxs` + `whatsapp-celery-worker-00103-zcs`; frontend Firebase Hosting `a35d451cf6b2a7c1`. Data migration 032/033 ran clean (032a 18 rows, 032b CV-less re-bucket 431 rows, 032c collapse 581+16 rows; candidates_status_chk + applications_status_chk applied; **zero CV-less candidates past New**). Verified by 40 jest tests, Vite build, py_compile, a 37-agent adversarial review (25 findings fixed), and live prod DB re-query + health checks. **Known follow-ups:** (a) `users_role_chk` not applied — `users` table is postgres-owned (WARN; role validity still app-enforced); (b) frontend went out via the Hosting REST API because the firebase CLI login expired (`firebase login --reauth` to restore). Two LOW review findings intentionally deferred (calling-console "Done→Screening" creating an application is by design; redundant `authorize()` under `requireSection` fails-closed).

> **✅ PHASE 3 SHIPPED + DEPLOYED + verified on prod (2026-06-07, commit `8f7a13f`).** Global **⌘K command palette** (new permission-aware `GET /api/search` + `CommandPalette.jsx` mounted in Layout), **sourcing control tower** (`GET /api/control-tower` single aggregator — per-project pipeline + stuck-SLA + overall pipeline, no N+1; `/control-tower` page gated projects:view + nav item), **quick-reply templates** (localized en/si/ta canned replies w/ {name}/{job} subst, inserted into the Messages composer, never auto-send), and **saved views** (named filter combos on Applications via the Phase-1 user_preferences `savedViews` namespace). Prod: backend `recruitment-backend-00095-pnp` (no migration); frontend Firebase `61ac36587a50974e`; chatbot unchanged. Verified: node --check, 46 jest pass (11 known OpenAI-401), combined vite build, 5/5 new SQL on prod schema, adversarial review (0 real bugs), + /api/search & /api/control-tower smoke-200 with admin JWT (control-tower shows ~314 stuck). **Next: Phase 4** (semantic matching + auto-shortlist · candidate self-service via the bot — full scope, the heaviest phase).

> **✅ PHASE 2 SHIPPED + DEPLOYED + verified on prod (2026-06-07, commit `0aae2b9`).** Project **Kanban** (drag-to-advance, native DnD → CV-gated setCandidateStage, optimistic+rollback; List/Board toggle on ProjectDetail), **accept-applications Inbox** tab on Applications (pending-screening queue, inline CV preview, Accept/Reject-to-pool + bulk via batch-certify + new `POST /api/applications/batch-reject-to-pool`), **onboarding checklist** on CandidateDetail (GET /api/candidates/:id now also returns `interviews`), and **#6 image→profile-picture** (migration 035 `candidates.photo_source`; manual upload locks with 'manual'; chatbot routes photo/selfie → `POST /api/chatbot/set-profile-photo` → GCS → photo_url+photo_source='auto', skips if manual-locked; document_processor no longer rejects selfies). Prod: backend `recruitment-backend-00094-44d` (migration 035 OK); chatbot `whatsapp-chatbot-00139-pdk` + `whatsapp-celery-worker-00104-8hx`; frontend Firebase `256fac5637a18855`. Verified: node --check, 46 jest pass (11 known OpenAI-401), combined vite build, py_compile (3 chatbot files), adversarial review (frontend clean; the "selfies crash the bot" finding disproved via the cv_service adapter), + all 3 new endpoints smoke-tested on prod (no side effects). **Fixed a LIVE Phase 1 crash:** all 14 prod jobs have object-shaped `requirements`, so the Phase 1 JobDrawer (`{job.requirements}`) crashed the Messages panel on every resolved-job chat — `RequirementsSection` now renders object|string safely (same React-#31 guard added in Communications.jsx + CVManager.jsx). **Next: Phase 3** (sourcing control tower, quick-reply templates, global ⌘K search, saved views).

> **✅ PHASE 1 SHIPPED + DEPLOYED + verified on prod (2026-06-07, commit `4a111c9`).** Persistent Messages workspace + **Job drawer** (#3.2/#3.0), per-role **"My Work Today"** home (#3), and the **CV-chase "Awaiting CV"** agent surface (#7, agent-facing half). Prod deploy: backend rev `recruitment-backend-00093-nct` (migration 034 = `user_preferences` table, applied OK); frontend Firebase Hosting `08249e570bba2104`; **chatbot unchanged** (its follow-up engine already chases CVs — see activation note). New: `GET /api/me/work-today`, `GET/PUT /api/preferences`, `GET /api/engagement/awaiting-cv`, `effective_job_id` on active-chats, `JobDrawer.jsx`, `Home.jsx` (Home replaces Dashboard for operational roles; admin keeps Dashboard). Verified: node --check, 46 jest pass (11 known OpenAI-401, not a regression), Vite build, **12/12 new SQL validated against the prod schema**, adversarial review clean, and **all 4 new endpoints smoke-tested to 200 on prod with an admin JWT**. **#7 CV-chase activation (user-only, NOT switched on — outward-facing):** ① approve Meta template `followup_template_missing_info` (+ si/ta) in WhatsApp Business Manager → ② set `ENABLE_FOLLOWUP_NUDGES=true` in chatbot env + redeploy chatbot → ③ create a Cloud Scheduler job POSTing `/webhook/internal/run-followups` every ~30 min. **Next: Phase 2** (project Kanban + accept-applications inbox + onboarding checklist + #6 smart image→profile-picture) — per the locked plan: phase-by-phase, pause for go-ahead before each prod deploy; Phase 4 full scope.

The original pre-Phase-0 handoff (now historical) follows.

### Already implemented this session (code done — NOT committed, separate from items #1–#6)
The "smart status + project filtering + calling-console workflow" feature (plan file `~/.claude/plans/in-the-conversation-uh-mossy-hearth.md`). What shipped:
- **Messages panel:** server-side **status-bucket tabs** (New/Screening/Certified/Interview Scheduled/Future Pool) + **server-side project filter** (effective project = latest application OR `ad_tracking` for not-yet-applied leads) + **live status badges** that move rows between buckets via a new `candidate_stage_changed` socket event.
- **Backend:** `active-chats` gained `status` + `project_id` filters, an `ad_tracking` join, and `effective_*` columns; `setCandidateStage()` extracted into `services/candidate-stage.js` (cascade → applications → re-derive + CV gate + protected-status guard + socket emit); call-logs handler rewritten for the smart **"Done → advance"** flow (job assignment, not-interested reason, `no_answer` task_type); **migration 031** (`call_logs.job_id/application_id/reason`); `candidate-tasks/due` got a `task_type` filter.
- **Frontend:** `CallRemarksPanel` redesigned (remark inputs, not-interested reasons, smart Done job picker); Engagement **"Catch-up (No answer)"** card.
- **Chatbot:** inbound-image **classification** (cv/id/passport/certificate/photo/selfie/other) — non-CV documents are now stored instead of dropped.
- **Verified:** backend `node --check` + **27 jest tests pass** (added `tests/candidate-stage.test.js` + active-chats filter tests); frontend **Vite build passes**; chatbot **py_compile passes**.

### Planned, NOT yet implemented — items #1–#6 below (design + decisions only)
| # | Item | Phase |
|---|---|---|
| 1 | Standardize candidate status to 7 values (apps collapse to 4 + `rejected`) | 0 |
| 5 | CV is the eligibility gate; fix auto-assign + New→Screening write-time gate | 0 |
| 2 | Enforce role-based access (wire `requireSection` + `RoleGuard`; role baselines) | 0 |
| 7 | CV-chase follow-up engine (templated nudges, zero-LLM, notify agents) | 1 |
| 3 | Per-role usability (persistent Messages + Job drawer, "My Work Today", Kanban…) | 1–3 |
| 6 | Smart image routing → profile picture + manual profile-pic upload | 2 |
| 4 | World-class layer: full candidate self-service + semantic matching/auto-shortlist | 4 |

### Decisions locked
- **7 statuses** canonical everywhere: `new, screening, certified, interview_scheduled, future_pool, merged, hired`. Applications collapse to 4 pipeline values + `rejected`; candidate status = furthest-along non-rejected application.
- **CV is the hard gate** — no CV ⇒ stays **New**, never assigned/prescreened/certified, never future_pool.
- **Roles (4):** `admin`, `project_handler`, `marketing_agent` (jobs **view-only**), `sourcing_department` (full ops except admin). Mandatory role baselines auto-applied on user-type select; project-scoping for handlers is a **deferred optional toggle**.
- **Phase 4 IN:** full candidate self-service via bot + semantic matching/auto-shortlist. **OUT:** compliance suite, client/employer portal.
- **Ad leads w/o CV:** keep the intent application (attribution) but **ineligible** until a CV arrives.
- **Inbound person-photo → profile picture**; manual upload wins + locks.

### Next step
**Phase 0:** item #1 (status standardization) + item #5 (CV gate / auto-assign fix) → item #2 (access enforcement). Nothing in #1–#6 is built yet.

---

## Build order (sequencing)

Foundations first (correctness + security), then the usability wins, then the world-class layer.

- **Phase 0 — Foundations:** #1 candidate-status standardization (everything keys off clean statuses) + #5 CV eligibility gate / auto-assign fix (write-time enforcement of New→Screening) → #2 access-control enforcement (security baseline + role baselines in the user form).
- **Phase 1 — Usability quick wins + CV chase:** persistent Messages workspace + **Job drawer** (the agent pain point) → per-role **"My Work Today"** home → **#7 CV-chase follow-up engine** (templated nudges + agent "Awaiting CV" list).
- **Phase 2 — Pipeline tooling:** project **Kanban** (drag to advance) + **accept-applications inbox** + onboarding checklist.
- **Phase 3 — Power tools:** sourcing control tower, quick-reply templates, global ⌘K search, saved views.
- **Phase 4 — World-class layer:** candidate **full self-service** via the bot + **semantic matching & auto-shortlist** (compliance + client portal are out of scope per #4).

Each phase ships behind the role access from #2 and is verified end-to-end before the next.

---

## 1. Standardize candidate status to a single 7-value vocabulary

**Goal:** One canonical status set for a candidate, used identically across backend, frontend, and chatbot. No parallel or ad-hoc status words anywhere.

### The 7 canonical statuses (`candidates.status`)
| value | meaning | type |
|---|---|---|
| `new` | lead in, no CV / not yet advanced | pipeline |
| `screening` | CV on file + assigned to a job | pipeline |
| `certified` | approved past screening | pipeline |
| `interview_scheduled` | interview set | pipeline |
| `future_pool` | no current match, saved for later | terminal/protected |
| `merged` | duplicate, folded into another candidate | terminal/protected |
| `hired` | placed | terminal/protected |

First 4 = the agent pipeline (the Messages tabs). Last 3 = terminal/protected (auto-sync never overwrites them).

### Scope of cleanup (remove / map away everything else)
- **`candidates.status`** is the single source of truth → enforce the 7 values everywhere it is written or read.
- **Retire `conversation_stage` as a separate vocabulary.** It currently carries its own words (`responding`, `interview`, `completed`). Keep the column only as a mirror of `status`, or drop it.
- **`applications.status` collapses to the same vocabulary** (DECIDED) so the lifecycle reads identically everywhere. Applications are per-job, so they use the 4 pipeline values **plus `rejected`** (a candidate can be rejected for one job yet active for another). The candidate's status is derived as the furthest-along **non-rejected** application.
  - **Allowed application values:** `screening`, `certified`, `interview_scheduled`, `hired`, `rejected`.
  - **Legacy → new mapping:**
    - `applied`, `auto_assigned`, `reviewing` → `screening`
    - `pre_screened` → `certified`
    - `interviewed`, `selected` → `interview_scheduled`
    - `placed` → `hired`
    - `transferred` → `rejected` (on the old job; a fresh application is created for the new job)
    - `merged` → handled at candidate level (`candidates.status = merged`), application closed
  - A one-time data migration rewrites existing `applications.status` to the new set.
- **Distinct axes that are NOT candidate status and stay separate:** `disposition` (call outcome), `cv_status` (CV processing), `ai_status`, computed `pipeline_stage`. These are not lifecycle status and must not be merged into the 7.

### Places to align (known today)
- `frontend/src/constants/lifecycle.js` — `STATUS_LABELS`, `STATUS_COLORS`, `CANDIDATE_STAGES`, stage maps. Make these the single shared definition; export the 7.
- `frontend/src/pages/Communications.jsx` — `STAGE_OPTIONS` (uses non-canonical `responding`/`interview`/`completed`).
- `backend/src/services/candidate-stage.js` — derivation + `PROTECTED_CANDIDATE_STATUSES` (already aligned to the 7).
- `backend/src/routes/candidates.js` — `VALID_CANDIDATE_STAGES`, status writes/filters.
- `backend/src/routes/communications.js` — `active-chats` status filter set (already the 7).
- `backend/src/config/migrations.js` / `database/schema.sql` — column comment still lists old words (`interview`, `hired`, `rejected`); align + optional CHECK constraint.
- Chatbot (`chatbot-intake.js`, Python intake) — default `new`, `future_pool` writes; verify no other status strings written to the candidate.

### Acceptance
- A repo-wide search finds candidate-status strings only from the shared 7-value enum.
- A candidate can only ever hold one of the 7 values (optionally enforced by a DB CHECK).
- Frontend status labels/colors come from one shared module.

**Status:** noted — not yet implemented.
**Decided:** collapse `applications.status` too (4 pipeline values + `rejected`); candidate status = furthest-along non-rejected application.

---

## 2. Enforce role-based access (close the unauthorized-section leak)

**Goal:** A user only ever sees and reaches the sections their user type allows — enforced on **both** the backend (API) and frontend (routes + nav), not just hidden in the menu. Picking a user type during user creation auto-applies a **mandatory baseline** of access; admins can still grant extras on top per user.

### Root cause of today's leak
The pieces already exist but aren't wired up:
- Backend `requireSection(section, action)` middleware (`middleware/sections.js`) is **defined but never called** — most GET/POST routes have only `authenticate`, so any logged-in user can hit them by direct API call.
- Frontend `RoleGuard` is used on **only 2 of 16 routes** (`/marketing-hub`, `/admin`) — every other page is reachable by typing the URL. Nav-menu filtering in `Layout.jsx` is cosmetic only.
- `user_section_permissions` table + `ROLE_DEFAULTS` exist but aren't enforced anywhere.
- `users.role` has **no CHECK constraint**; `project_assignments` exists but is never used to scope a handler to their projects.

### The model (two layers — keeps the existing "default way", adds a mandatory way)
- **Mandatory role baseline (NEW):** each user type has a locked minimum set of sections. Selecting the type in the create/edit form **auto-fills + locks** those rows in the permission matrix. This is the "mutual/mandatory" access the user asked for.
- **Per-user grants (EXISTING):** admin can still add extra section permissions on top via the matrix; they cannot remove the mandatory baseline.
- Both layers are stored in the existing `user_section_permissions` table and enforced by `requireSection()` / `RoleGuard`.

### Sections (already seeded)
`dashboard, candidates, jobs, projects, applications, interviews, communications (messages), cv_manager, analytics, knowledge_base, marketing_hub, general_pool`

### Mandatory access matrix (V=view, C=create, E=edit, D=delete)
| Section | admin | project_handler | marketing_agent | sourcing_department* |
|---|---|---|---|---|
| dashboard | VCED | V | V | V |
| projects | VCED | V C E | — | V C E |
| applications | VCED | V E (accept) | — | V C E |
| candidates | VCED | V E | V | V C E |
| cv_manager | VCED | V C E | V C E | V C E |
| communications (messages) | VCED | V E | V E | V E |
| interviews | VCED | V C E | — | V C E |
| jobs | VCED | V | V (read-only) | V C E |
| marketing_hub | VCED | — | V C E | V C E |
| analytics | VCED | V | — | V |
| general_pool | VCED | V | — | V C E |
| knowledge_base | VCED | — | — | V C E |
| admin panel | VCED | — | — | — |

Derived from the brief: **project_handler** = projects + accept applications + CV manager + messages (+ adjacent candidates/interviews the pipeline needs). **marketing_agent** = jobs (**view-only**) + messages + CV manager + marketing hub + candidates view — they run the full candidate onboarding from chat and only *reference* job descriptions. **sourcing_department** = full operations except the admin panel.

### Quick-assign on user-type select
- In `UserFormModal`, choosing a role pre-checks and **locks** that role's mandatory rows in `SectionPermissionMatrix`; optional rows stay editable for extra grants.
- Define the baseline once in a shared `ROLE_BASELINE` map (backend `ROLE_DEFAULTS` is the source of truth; frontend imports/mirrors it) so create + enforce + display never drift.

### Enforcement work
- **Backend:** add `requireSection('<section>', '<action>')` to every route group — `view` on GETs, `create/edit/delete` on writes. Reuse the existing middleware. Admin bypasses.
- **Frontend:** wrap every route in `App.jsx` with `RoleGuard` carrying its `section` + action; keep nav filtering as the cosmetic layer. Unauthorized direct-URL navigation → redirect to dashboard with a "no access" notice.
- **Data integrity:** add a CHECK constraint on `users.role` (the 4 canonical roles) and make role selection drive the baseline insert on user create/update.
- **(Phase 2) Project scoping:** use `project_assignments` so a `project_handler` only sees/edits their assigned projects (and the candidates/apps under them), not all.

### Acceptance
- A non-admin cannot reach a disallowed page by URL **or** the API (403), not just a hidden menu item.
- Creating a user + picking a type auto-applies the mandatory baseline with no manual toggling.
- Every section's GET and write paths are guarded; admin retains full access.

**Status:** noted — not yet implemented.
**Decisions:** (a) `sourcing_department` = full ops except admin panel ✓. (b) `marketing_agent` gets **jobs view-only** ✓. (c) project-scoping for `project_handler` is **deferred** — but ship it as an **optional per-user toggle** "Restrict to assigned projects" (off by default; admin can switch on). When on, `requireSection` is combined with a `project_assignments` filter so the handler only sees/edits their projects and the candidates/apps under them.

---

## 3. Usability & ease-of-access — make every role's job effortless (and solid)

**Principle:** every feature below is backed by real data + server enforcement (no dead buttons, no cosmetic-only state). Optimistic UI always reconciles with the server and rolls back on error. All of it respects the access matrix in #2.

### 3.0 Cross-cutting (every role)
- **Never lose your place (TOP PRIORITY).** The Messages workspace (status bucket + project + selected chat + scroll) and every list's filters persist across navigation **and** refresh — URL params + per-user server preference (extends the `comms.projectId` localStorage already shipped). *Directly fixes:* an agent opening a job and landing back on "all chats".
- **Inline drawers instead of page jumps (TOP PRIORITY).** CV preview, **job description**, and candidate profile open as a slide-over **over the current page** — you never navigate away. Reuse `CVReviewModal` / `ConversationDocumentsPanel`; add a `JobDrawer`.
- **Role home — "My Work Today".** Each role lands on a queue of what needs action right now (real counts + lists), not a generic dashboard. e.g. handler: new applicants, screenings due, interviews today; agent: my unread chats, no-answer catch-ups, new leads.
- **Global search / ⌘K.** Jump to any candidate (phone/name), job, or project from anywhere. Backed by a search endpoint with proper indexes.
- **"Back" returns you exactly where you were** (restored filtered list + scroll), and a breadcrumb shows context.
- **Toasts + undo** on every state change (advance stage, accept, reject) so mistakes are one click to revert.
- **Permission-aware UI:** disallowed actions are hidden, not just 403'd — the UI reads the same baseline as #2.

### 3.1 Project Handler — run the pipeline at a glance
- **Project pipeline board (Kanban):** columns New → Screening → Certified → Interview; drag a card to advance (calls `setCandidateStage`, fully synced with #1). One board per project.
- **Accept-applications inbox:** a focused queue of pending applications for *their* projects with inline CV preview and one-click **Accept / Reject-to-pool** + bulk select.
- **Candidate onboarding checklist:** CV ✓ · job assigned ✓ · screened ✓ · docs ✓ · interview ✓ — progress derived from real data (`cv_files`, `applications`, `interviews`), so "what's missing" is obvious.
- **Bulk actions:** multi-select certify / schedule interview / message.

### 3.2 Marketing Agent — onboard without leaving the chat
- **Job drawer inside Messages (TOP PRIORITY — your pain point):** a "View job" button on the open conversation opens the candidate's applied role (or a quick job picker) as a side drawer with salary / requirements / benefits / country — **the chat and your filter stay put.**
- **Pinned job cheat-sheet** in the right panel for the candidate's role (key facts always visible while talking).
- **Quick replies / templates:** canned, localized answers (salary, benefits, how-to-apply) insertable into chat with `{name}`/`{job}` substitution.
- **Full onboarding from chat:** capture CV → assign job → advance, in the conversation (extends the calling-console "Done → advance" already shipped).
- **Lead-to-candidate continuity:** marketing-hub lead opens straight into its conversation with one click.

### 3.3 Sourcing Department — the control tower
- **Cross-project health board:** every project's pipeline counts, bottlenecks, and **stuck-candidate SLA** (idle > N days — reuse `engagement` stuck query).
- **Bulk source & assign:** assign candidates to jobs/handlers in bulk; transfer between jobs.
- **Saved views:** save filter combos (e.g. "Lulu · New · no CV") and reopen in one click.
- **Team workload & activity:** per-handler/agent load + call/engagement rollup (the call-logs rollup already exists).

### 3.4 Admin — manage with confidence
- **Quick role-baseline assign** (from #2): pick a type → mandatory access auto-applied + locked.
- **"View as role":** preview the app exactly as a given role to verify access without a second login.
- **Audit search:** who changed what/when, filterable (`audit_logs` already exists).
- **User KPIs / activity** surfaced per user (endpoints already exist).

### Solidity guardrails (apply to all of the above)
- Server is the source of truth; UI state reconciles and rolls back on failure.
- Preferences persist per user (server-side), not just in the browser.
- Every list is permission-filtered server-side, so "hidden in the UI" is never the only defense.
- Features degrade gracefully if a section is not permitted for the role.

**Status:** noted — not yet implemented.
**Priorities:** (1) persistent Messages workspace + Job drawer (the agent pain point), (2) role "My Work Today" home, (3) project Kanban + accept-applications inbox, (4) the rest.

---

## 4. What it takes to be the best — 4 perspectives (my opinions)

My expert read on the crucial things, by lens. Items marked **★** are the highest-leverage. Open decisions for you are at the bottom.

### A. Candidate perspective (the WhatsApp job-seeker)
- **★ Radical clarity & trust:** show salary, country, employer, benefits, and *real* terms up front; never bait-and-switch. Capture consent on first contact. This is what separates a trusted agency from a scam in this market.
- **★ Self-service status:** let a candidate ask "where am I?" and get their stage + next step + what's needed from them — cuts agent load massively.
- **Lowest-friction onboarding:** CV as photo/voice/doc (mostly done), ask the minimum, let them finish later and resume where they left off.
- **Proactive comms:** interview reminders, status-change nudges, future-pool re-engagement (engine exists) — keep candidates warm.
- **Respect & feedback:** clear rejection reason, "we'll keep you for X", easy withdraw/reschedule.
- **Accessibility:** Sinhala/Tamil/English/Singlish + voice (have); fast on low-end phones.

### B. System-user perspective (agents / handlers / marketing / sourcing)
- **★ One screen, full context:** profile + history + docs + job inline via drawers — no hunting, no lost place (item #3).
- **Zero double-work:** claim/presence (done), clear ownership, visible handoff trail.
- **Speed tools:** templates, bulk actions, keyboard shortcuts, saved views.
- **Mobile-friendly** for agents working on the move.
- **Know your numbers:** personal + team KPIs, what's overdue, catch-up lists (started).
- **Forgiving:** undo, autosave, never lose work.

### C. Real-world / operational perspective
- **★ Compliance (legal must):** Sri Lanka foreign-employment regulation (SLBFE), contract transparency, anti-trafficking safeguards, and data privacy/consent (PDPA). For overseas recruitment this is not optional — it protects candidates and the business.
- **★ Reliability:** WhatsApp token/delivery monitoring + retries (the token split-brain has bitten before), a real message queue, and health alerts.
- **Cost control:** AI + WhatsApp spend dashboards, model routing, caching.
- **Scale:** thousands of candidates / many concurrent chats — pagination + indexes everywhere (retire any 5000-row caps).
- **Data quality:** dedupe (have merge), phone-number changes, multiple numbers per person.
- **Trust & safety:** fraud/scam detection, full audit trail, backups + disaster recovery.

### D. Advanced recruitment-systems perspective
- **★ Smart matching & ranking:** semantic/embedding match + auto-shortlist + "why matched" explainability (today it's rule-based).
- **★ Client/employer portal:** clients (e.g. Lulu) view and approve their shortlist and see pipeline — a real differentiator and time-saver.
- **Automation rules / SLAs:** "stuck > N days → auto-nudge/escalate", configurable playbooks.
- **Interview ops:** calendar sync, panel scheduling, reminders, no-show handling.
- **Contracts & placement:** e-sign offer letters, placement tracking, post-placement follow-up.
- **Action-driving analytics:** funnel conversion, source ROI (ad tracking exists), time-to-fill, agent performance.
- **Integrations:** job boards, calendars, e-sign, accounting.

### Decisions (drives Phase 4)
1. **Candidate self-service = FULL** ✓ — bot answers "where am I?" (stage + next step), and lets candidates **reschedule interviews** and **update their info**. Needs: a candidate-auth-by-phone path, self-serve intents in the chatbot, and guarded write-backs (reschedule → interviews, profile edits → candidate/metadata) with an audit trail.
2. **Compliance = OUT OF SCOPE for now** ✗ — SLBFE/contract/PDPA workflows deferred. (Keep the existing consent/disclosure behavior; revisit later.)
3. **Client/employer portal = INTERNAL ONLY** ✗ — no client login; team relays candidates. (Don't build a portal.)
4. **AI matching = SEMANTIC + AUTO-SHORTLIST** ✓ — embedding-based match, ranked auto-shortlists, and "why matched" explainability. Needs: an embeddings/vector layer over CV + job text, a scoring service, and shortlist surfacing in the handler/sourcing views.

**Phase 4 scope (locked):** (a) candidate full self-service via the bot, (b) semantic matching + auto-shortlist. **Excluded:** compliance suite, client portal.

**Status:** decisions recorded — implementation pending.

---

## 5. CV is the eligibility gate — fix auto-assign & enforce New → Screening

**Problem (real bug):** candidates are being assigned to jobs and pulled into prescreening **before** they've provided a CV, so Applications is full of candidates with no CV/details. The lifecycle gate is enforced for *display* but not at the *assignment/write* layer.

**Rule (locked):** a candidate in **New** must have a **CV on file** to become eligible. Only then: **New → Screening (prescreening) → Certified → Interview Scheduled**. No CV ⇒ stays **New** (awaiting CV) — never auto-assigned, never prescreened, never certified, and never dropped into future_pool.

**Eligibility test:** `candidates.cv_uploaded = true` **OR** a `cv_files` row exists. (Per-job "required details / required_fields_schema" can be layered as an *additional* gate later — CV is the hard floor now.)

### Bugs to fix
- **`auto-assign.js` — parsed-signal bypass:** the no-CV guard (`cv_uploaded !== true && !hasParsedSignal`) lets chat-only candidates (skills typed in chat, no CV file) score and get assigned. → For any **assignment**, require a real CV; drop the parsed-signal bypass from the assign decision.
- **`auto-assign.js` — wrong future_pool move:** CV-less, no-match candidates are pushed to `future_pool`. future_pool = *has CV but no matching role*. No CV ⇒ keep **New**. Add the CV check before the future_pool transition.
- **`applications.js POST /` (manual assign)** and the **chatbot ad-funnel** create applications with no CV gate.

### Design — separate *intent* from *eligibility*
- **Keep the ad-funnel "intent" application** (preserves which job a lead came from — attribution), but the candidate stays **New** and **ineligible** (excluded from prescreening, job-match lists, and certify actions) until a CV arrives. `candidate-stage.js` already forces New without a CV — extend that same gate to the *eligibility surfaces* (auto-assign, job-candidate lists, prescreening/certify buttons).
- **Block** any *new* manual/auto assignment that would move a CV-less candidate into prescreening — reuse the existing `422 screening_gate` response ("Upload a CV before assigning / prescreening").

### Touch points
`backend/src/routes/auto-assign.js` (CV gate + future_pool fix), `backend/src/routes/applications.js` (POST gate), `backend/src/services/candidate-stage.js` (status source of truth — keep), chatbot intake (intent application allowed but flagged ineligible), job-candidate & prescreening views (filter "eligible" = CV present).

**Reinforces item #1:** this is the *write-time* enforcement of the New→Screening gate that #1 defines. Belongs in **Phase 0** alongside #1.

**Decided:** ad-funnel leads **keep the intent application** (preserves attribution + "which role") but are **marked ineligible** until a CV arrives. Mechanism: the candidate stays **New** (status gate already does this), and every *eligibility surface* — auto-assign, job-candidate/match lists, and prescreening/certify actions — filters to **CV present**, so the intent application is invisible there until the CV lands. No new application sub-status needed (stays consistent with #1).

**Status:** noted — not yet implemented.

---

## 6. Smart image routing → candidate profile picture (+ manual upload)

**Context:** refines the image classification already shipped (categories `cv / id / passport / certificate / photo / selfie / other`). A personal photo of the candidate must **become their profile picture**, not be dropped.

### Inbound chat-image routing
- **CV / resume** → parse as CV (drives the eligibility gate, #5).
- **ID / passport / certificate** → store as a supporting **document** (CV Manager + conversation).
- **Personal photo of the person (headshot / selfie / portrait)** → set as **`candidates.photo_url`** (profile picture) — *not* a document.
- **Unrelated (meme / screenshot / scenery / product)** → ignore (friendly ack, store nothing).

> Behavior change vs Part F: `selfie`/`photo` are no longer rejected — they route to the profile picture. Only `other` is ignored.

### Profile-picture rules
- Track source with a `photo_source` flag (`auto` | `manual`).
- Auto-set from a detected person-photo **only if** there's no manually-set picture; the latest detected photo refreshes an `auto` picture. A **manual** upload always wins and **locks** (auto never overwrites it).
- Store via existing `candidates.photo_url` + the existing GCS upload path.

### Manual upload
- Agent control to upload/replace a candidate's profile picture from the **candidate profile / CV Manager / conversation right-panel**. Validates type+size, uploads to GCS, sets `photo_url`, marks `photo_source = manual` (locked).

### Touch points
Chatbot `document_processor.py` (classifier already returns the category) → `cv_service.py` / `orchestrator.py` (route `photo`/`selfie` to a profile-picture push instead of a document); backend candidate update (accept a profile-photo upload + `photo_source`); frontend (show the avatar + a manual upload control). Reuses the GCS uploader and `candidates.photo_url` (already exists).

**Build phase:** Phase 2 (onboarding / data-quality) — also feeds the handler onboarding checklist in #3.

**Status:** noted — not yet implemented.

---

## 7. CV-chase follow-up engine (get the CV, then notify agents) — cost-aware

**Problem:** chatbot follow-ups aren't firing, so candidates who start intake but never send a CV go cold and nobody chases them. CV is the gate (#5), so this is the pipeline's #1 conversion leak.

**Goal:** a smart, **bounded** sequence that nudges a *New + no-CV* candidate to send their CV, **stops the instant it arrives**, and hands off to an agent if it doesn't — with **short, one-line messages** and **minimal API cost**.

### Cadence (CV chase) — short, localized, capped
Trigger: candidate is **New**, **no CV on file**, intake started, not opted out.
1. **Nudge 1 — +3h** (usually still inside WhatsApp's 24h window → short **free-form** text, no extra cost).
2. **Nudge 2 — +1 day** (outside window → approved **template**).
3. **Nudge 3 — +3 days** (template), then **STOP** (cap = 3) and hand to an agent.
Stop immediately on: CV received · candidate replies · advances past New · opt-out.

One-line message, e.g. *"Hi {name}, please send your CV (a clear photo is fine) so we can move your {job} application forward."* — localized (en/si/ta/singlish/tanglish).

### Cost controls (key)
- **Nudges are static localized templates — ZERO LLM tokens** (no GPT call to compose). Main saving.
- **Cap at 3 sends**; prefer the free in-window text first. Each WhatsApp **template opens a paid conversation**, so attempts stay bounded.
- **One batched scheduler pass** selects all due nudges (no per-candidate cron).

### Notify the agents
- After the sequence exhausts (or after nudge 2 with no reply), open a `candidate_task` **`task_type = 'awaiting_cv'`** for the project's pool → surfaces in the Engagement **"Awaiting CV"** list (extends the no-answer catch-up card already shipped) + a dashboard counter ("X candidates need a CV"). Agent then calls via the calling console.

### Solid mechanics
- Per-candidate state: `cv_followup_stage`, `cv_followup_count`, `next_cv_followup_at`, `last_cv_nudge_at` (new columns or a `candidate_tasks` row).
- Cloud Scheduler → endpoint: select due (`next_cv_followup_at <= now` AND `status='new'` AND no CV AND attempts < cap AND not opted-out) → send → schedule next / stop. **Idempotent + rate-limited** (never double-send).
- Respects the **24h window**: inside → free-form short text; outside → approved template (graceful skip + log if neither available).
- Reuses existing infra: `ENABLE_FOLLOWUP_NUDGES`, Meta `TEMPLATE_*` vars, the Cloud Scheduler jobs, `candidate_tasks` + the Engagement surfaces.

### Diagnose first (why it's silent today)
Verify before building: `ENABLE_FOLLOWUP_NUDGES` on · `TEMPLATE_*` set **and templates approved in Meta** · Cloud Scheduler jobs running + hitting the right URL · WhatsApp **token not expired** (token split-brain breaks sends) · the 24h-window/template fallback path. (See memories: *follow-up & reminder system*, *WhatsApp token split-brain*.)

**Build phase:** Phase 1 (depends on the #1/#5 "New + no-CV" signal).
**Status:** noted — not yet implemented.
