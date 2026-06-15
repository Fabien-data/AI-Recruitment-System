# 3CX ↔ AI Recruitment System — Final Call-Center Integration Plan

> **Status:** Final plan (planning only — no implementation yet).
> **Objective:** Operate the 15-agent desk as one **end-to-end, streamlined call center** — queues, transfer, forwarding, call handling, supervisor tools, recording, agent engagement — by **maximally reusing native 3CX features + the 3CX CRM connector** and our existing recruitment system, building only thin glue.
> **Research basis:** 11-agent deep-research workflow, all edition/API claims adversarially verified against official 3CX v20 docs (June 2026). Citations in §13.

---

## 1. The One Big Idea (read this first)

**You do not build a call center. 3CX *is* the call center; our app stays the CRM/source-of-truth and gets glued to it.**

The research proved that **almost every "phone system feature" you listed is native to 3CX PRO and requires only PBX *configuration*, zero code**:

> call queues · ring groups · agent login/logout · wrap-up · queue callbacks · SLA alerts · **blind + attended transfer** · **call forwarding / Office Hours / DND / Follow-Me** · hold · **call parking** · conference · IVR/Digital Receptionist · **call recording** · **supervisor Listen / Whisper / Barge-in** · wallboard · hot desking · voicemail.

Our integration is therefore a **thin three-part glue layer**, all available on **PRO**:
1. **Auto-logging** — 3CX *Call Journaling* fires our webhook on every call-end → we write a `call_logs` row, attributed to the right agent, feeding the existing engagement leaderboard.
2. **Screen-pop** — 3CX *Contact Lookup* hits our lookup endpoint → caller ID shows the candidate; we socket-pop their chat to the agent.
3. **Click-to-dial** — agents dial from our console via the *Click2Call* extension / Web Client deep-link.

Everything else ("transfer, handling, forwarding, supervisor") is **turned on in 3CX, not coded by us.** That is what makes "end-to-end, today" realistic.

> **What is NOT today:** driving calls/transfers *from buttons inside our own app UI* needs the 3CX **Call Control API (XAPI)** — which is **Enterprise-only + self-hosted-only + needs a relay on the PBX**. That's a clearly-labeled **future Tier 2** (§9), not the MVP. Agents perform transfer/hold/conference in the 3CX Web Client that sits beside our console — native, instant, no build.

---

## 2. Goals & Non-Goals

**Goals (Tier 1 — today/this week)**
- Agents dial candidates in one click from the console; every call auto-logs to the candidate timeline, correctly attributed.
- Inbound calls screen-pop the candidate to the responsible agent with a real caller-ID name.
- Full native call-center behaviour live in 3CX: queues, transfer, forwarding, hold/park/conference, recording, supervisor listen/whisper/barge, wallboard, IVR.
- Per-agent engagement (calls, talk outcomes) flows into the **existing** leaderboard with no new analytics stack.

**Non-Goals (deferred / Tier 2)**
- In-app call-control buttons (transfer/hangup/originate from our UI) → needs Enterprise + self-host + XAPI relay (§9).
- Skills-based queue routing, admin-locked mandatory recording, AI receptionist → Enterprise/AI edition.
- Moving WhatsApp into 3CX → **explicitly rejected** (§7); keep our Meta Cloud API + chatbot.
- Reading 3CX's own database directly → **unsupported, voids support** (§6); we rely on our own `call_logs`.

---

## 3. Verified Edition / Sizing / Hosting Decision

| Decision | Recommendation | Verified rationale |
|---|---|---|
| **Edition** | **3CX PRO** | Confirmed: PRO includes queues, **recording**, **supervisor listen/whisper/barge**, **wallboard**, reporting, and **CRM integration** (lookup/journaling/click2call). "Basic" lacks recording, queues, and CRM → dead end. Enterprise/AI only needed for skills-based routing, admin-locked recording, AI receptionist, or the XAPI (Tier 2). |
| **Simultaneous Calls (SC)** | **16 SC** floor · **32 SC** recommended | 15 agents → up to 15 concurrent talk paths + queue hold (waiting callers also consume SC). 16 SC = one call per agent + headroom; 32 SC = comfortable queue overflow. (Research first suggested 64 SC — over-sized for 15 agents; right-sized down. Note **16 SC is also the floor for CDR Data Connectors** if you later push 3CX CDR into Postgres.) Jan-30-2026 **Fair User Policy** (1:8 ext:SC min) + annual subscription apply — size up front to avoid spike charges. |
| **Hosting** | **Self-hosted on your existing GCP** (recommended) · 3CX-hosted only if you'll *never* want XAPI | **Critical, verified:** the Call Control API (Tier 2 in-app control) works **only on on-prem/self-hosted**, never on 3CX-Cloud-Hosted. Self-hosting on GCP keeps that upgrade path open, allows CDR Data Connectors into our Postgres, and co-locates the PBX with our backend (low webhook latency). 3CX-hosted is simpler but permanently closes the XAPI door. License cost is identical either way. |
| **SIP trunk + DIDs** | Keep current provider's trunk or a 3CX-supported one; port DIDs | 3CX is not a carrier — "going direct" still needs a SIP trunk for PSTN to LK + Gulf numbers. |
| **Recording** | PRO (agent start/stop) | Enterprise only needed if compliance requires admin-locked mandatory recording. |

> Confirm live PRO SC-tier pricing with 3CX sales at purchase (Q2-2026 promo up to ~30% off; treat any online figure as a snapshot).

---

## 4. Feature → Mechanism Matrix (condensed, verified)

Legend: **[A]** Native 3CX (config, no build) · **[B]** CRM connector (template) · **[D]** Build/reflect in our app · **[C]** Call Control API (Tier 2, Enterprise+self-host).

| Capability | Class | Edition | Who does it |
|---|---|---|---|
| Queues + polling (ring-all, round-robin, hunt, longest-idle, fewest-answered) | [A] | PRO | 3CX admin config |
| Skills-based routing | [A] | **Enterprise** | 3CX admin config |
| Wrap-up time · queue callbacks · SLA email alerts | [A] | PRO | 3CX admin config |
| Ring groups · agent login/logout (*62/*63) | [A] | Basic+ | Agents / config |
| **Blind + attended transfer** | [A] | Basic+ | Agent in Web Client (*82 / Att.transfer) |
| **Forwarding · Office Hours · DND · Follow-Me · mobile rebound** | [A] | Basic+ | Agent/admin config |
| Hold · **park** (*0x/*1x) · conference (*85) | [A] | Basic+ | Agent in Web Client |
| **Supervisor Listen / Whisper / Barge-in** | [A] | PRO | Manager in Web Client |
| Call recording (+ recording_url in CDR) | [A] | PRO | 3CX config; URL flows to us |
| Wallboard / live queue stats | [A] | PRO | 3CX Web Client (optionally mirrored in our app) |
| Hot desking · presence/BLF · voicemail · IVR | [A] | PRO/Basic | 3CX config |
| **Contact lookup → screen-pop** | [B]+[D] | PRO | 3CX template → our `/contact-lookup` + socket |
| **Call journaling → auto `call_logs`** | [B]+[D] | PRO | 3CX ReportCall → our `/call-event` webhook |
| **Click-to-call (outbound from our console)** | [B]+[D] | PRO | Click2Call extension / Web Client deep-link |
| Engagement leaderboard from journaled calls | [D] | PRO | Reuse existing `engagement.js` |
| Programmatic originate / transfer / barge **from our UI** | [C] | **Enterprise + self-host + relay** | Tier 2 future (§9) |

---

## 5. Reuse vs Build (our system already has ~70%)

**Reuse as-is (no rebuild):**
- `call_logs` table + the call-start/end/heartbeat/logs endpoints in [communications.js](../recruitment-system/backend/src/routes/communications.js) (~L960–1330).
- `claim_sessions` + `getOpenClaimSessionId()` ([claim-sessions.js](../recruitment-system/backend/src/services/claim-sessions.js)) — auto-attributes calls to the agent.
- Engagement leaderboard ([engagement.js](../recruitment-system/backend/src/routes/engagement.js) ~L312–470) — `calls_logged`, outcomes, etc. 3CX-journaled rows feed it natively.
- Socket.io rooms + events (`call_status_changed`, `disposition_changed`, …) in [websocket.js](../recruitment-system/backend/src/utils/websocket.js).
- `CallPresenceToggle`, `CallRemarksPanel`, `DispositionSelect` UI in [Communications.jsx](../recruitment-system/frontend/src/pages/Communications.jsx).
- `phoneVariants()` ([utils/phone.js](../recruitment-system/backend/src/utils/phone.js)) and [ClickToCall.jsx](../recruitment-system/frontend/src/components/ClickToCall.jsx).
- Existing webhook skeleton [webhooks-3cx.js](../recruitment-system/backend/src/routes/webhooks-3cx.js).

**Must add (thin glue, ~2–3 days):**
1. `users.pbx_extension VARCHAR(20)` + unique index, and a tiny admin CRUD to set it per agent.
2. `call_logs`: `external_call_id`, `source DEFAULT 'manual'`, `recording_url` + unique idempotency index.
3. **Retarget the webhook**: match caller → **candidates** via `phoneVariants` (not `marketing_leads`), resolve `agent_extension` → `users.id`, write one `call_logs` row on call-end (idempotent), stamp `claim_session_id`.
4. New `GET /webhooks/3cx/contact-lookup` for caller-ID + screen-pop.
5. New socket `incoming_call` emit + frontend listener; mount `ClickToCall` in the console.
6. Fix `.env.example`; add `docs/3cx-integration.md` (admin steps + 15-row extension↔agent map).

---

## 6. Data flow (Tier 1)

**Outbound:** agent clicks Call → Click2Call/Web Client dials via their extension → 3CX places call over SIP trunk → on hang-up, 3CX *ReportCall* POSTs `/webhooks/3cx/call-event` → backend matches candidate + extension→agent, inserts `call_logs` (source=`3cx`), stamps claim → socket `call_status_changed` → timeline + leaderboard update live.

**Inbound:** candidate dials a DID → 3CX *Contact Lookup* GETs `/webhooks/3cx/contact-lookup?number=…` → returns candidate name/stage → 3CX shows real caller ID → 3CX rings the queue/extension; on ring, journaling webhook → backend emits `incoming_call` to `agent:{claimed_by}` (or the extension's agent) → console banner + auto-selects the chat → on hang-up, `call_logs` row as above.

**Stats:** we **never** read 3CX's database (verified unsupported — voids support). Engagement comes from our own `call_logs`, populated by journaling. Optional later: 3CX **Data Connectors** (16 SC+) push CDR into our Postgres, or the read-only `/xapi/v1/CallHistoryView` API for reconciliation.

---

## 7. WhatsApp boundary — KEEP SEPARATE (verified)

**3CX = voice only. Our Meta Cloud API + chatbot keeps WhatsApp.** Verified reasons: a WhatsApp number binds to one provider; routing it through 3CX would cut off our Meta integration. Meta "Coexistence" (May 2025) only covers *Business App + Cloud API*, **not** third-party platforms like 3CX, and 3CX does not officially document coexistence support. Rebuilding our qualification chatbot inside 3CX's AI Receptionist (AI edition) is unjustified cost. Voice-qualified candidates can still be handed to a 3CX queue, and our screen-pop ties the two channels together in one console.

---

## 8. Phased delivery (Tier 1)

| Phase | What | Build? | Today-able? |
|---|---|---|---|
| **0 — Procure & provision** | Buy **PRO 16–32 SC, self-hosted on GCP**; SIP trunk + DIDs; create 15 extensions; capture FQDN, egress IPs, webhook token | Ops | Gated by purchase |
| **1 — Backend glue** | Migrations (extension col, call_logs cols); retarget webhook to candidates/`call_logs` + extension→agent; idempotency; tests | ~1.5 d | ✅ once token/extensions known |
| **2 — Agent mapping** | Ensure all 15 user accounts exist (seed has 5); admin field to set `pbx_extension`; populate 15 | ~1 d | ✅ |
| **3 — Outbound + screen-pop** | Mount `ClickToCall` (set `VITE_THREECX_WEB_URL`); add `/contact-lookup`; `incoming_call` socket + listener | ~2 d | ✅ |
| **4 — 3CX configuration (PBX, no code)** | Queues + polling, transfer/forward/Office-Hours/DND, recording, **supervisor listen/whisper/barge**, IVR, wallboard, hot desking; CRM template (Journaling → `/call-event`, Lookup → `/contact-lookup`, token header); install Click2Call extension; agents log into Web Client | Config | ✅ (admin, same day) |
| **5 — Env, docs, harden** | Fix `.env.example`; write `docs/3cx-integration.md`; confirm backend **single Cloud Run instance** (socket.io in-memory adapter); rate-limit + IP allowlist | ~1 d | ✅ |

**Realistic "today":** Phase 4 (native call-center config) + the CRM journaling/lookup templates can go live the moment the PRO instance + extensions exist — delivering queues, transfer, forwarding, supervision, recording, and auto-logging same-day. Phases 1–3 (≈4.5 eng-days) wire click-to-dial + screen-pop into our console. **Tier-1 total ≈ 5.5 eng-days + same-day PBX config**, parallel to procurement.

---

## 9. Tier 2 (future, optional) — in-app call control via XAPI

If you later want **dial / transfer / hold / hangup / supervisor-barge as buttons inside our app** and real-time call-event-driven UI:
- Requires **Enterprise edition + self-hosted 3CX** (already chosen if you self-host) + a **relay/proxy service on the PBX host** (XAPI binds to localhost only).
- Auth: OAuth2 client-credentials (`/connect/token`, 60-min tokens); endpoints `/callcontrol/.../makecall`, `BeginTransfer`/`CompleteTransfer`, hold, drop; WebSocket for live events.
- Effort: ~3–5 days + ops for the relay + token lifecycle + error handling.
- **Recommendation:** ship Tier 1 first; only pursue Tier 2 if agents demand never leaving our UI. Self-hosting now (Phase 0) keeps this door open at no extra license cost.

---

## 10. Data model & contracts (summary)

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS pbx_extension VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_pbx_extension ON users(pbx_extension) WHERE pbx_extension IS NOT NULL;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS external_call_id VARCHAR(128);
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS source VARCHAR(16) DEFAULT 'manual';
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS recording_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_call_logs_external_call_id ON call_logs(external_call_id) WHERE external_call_id IS NOT NULL;
```
- `POST /webhooks/3cx/call-event` (retargeted) — auth `X-3cx-Token`; on call-end → one attributed `call_logs` row.
- `GET /webhooks/3cx/contact-lookup?number=…` (new) — auth `X-3cx-Token`; returns `{candidate_id, name, stage}` or 404.
- Socket `incoming_call` (new) — `{candidate_id, candidate_name, caller_number, ts}` → `agent:{id}` + `candidate:{id}`.

## 11. Deploy & rollback
- Deploy order: **backend first** (runs migrations) → `gcloud run deploy` then **`update-traffic`** → verify `/webhooks/3cx/ping` + replayed payload → configure 3CX templates → frontend → docs. Keep backend **min=1/max=1** (socket.io). No chatbot changes.
- Rollback: migrations are additive (safe). Unset `THREECX_WEBHOOK_TOKEN` → webhook 503s (kills inbound logging). Unset `VITE_THREECX_WEB_URL` → ClickToCall falls back to `tel:`. Manual logging always remains.

## 12. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Buying Basic (no CRM/recording/queues) | **Buy PRO** — confirm CRM + recording + queues in the quote. |
| Choosing 3CX-Cloud-Hosted then wanting XAPI | **Self-host on GCP** now — Cloud-Hosted permanently blocks XAPI. |
| Under-sized SC → busy signals / FUP charges | 16 SC floor, 32 recommended; watch concurrent-call reports. |
| Reading 3CX DB for stats | Don't — unsupported; use our `call_logs` (journaling) + optional Data Connectors. |
| Backend scaled >1 instance | Pin min=1/max=1 (in-memory socket adapter). |
| WhatsApp number routed to 3CX | Keep voice-only separation (§7). |
| Unmatched caller / unmapped extension | Log raw-only when no candidate; Phase 2 enforces all 15 extensions mapped. |
| Duplicate webhook deliveries | `external_call_id` unique index + existing `(call_id,event_type)` guard. |

## 13. Verification & sources
**Verify E2E:** outbound click → dial → `call_logs` row + leaderboard increment; inbound → screen-pop + caller-ID name; transfer/forward/supervisor work in Web Client (native); idempotent replay → no dup; two concurrent calls → both live events. Unit: extension resolution, `phoneVariants` match, idempotency.

**Sources (official 3CX v20 docs, verified June 2026):**
- Call Control API — Enterprise + on-prem/self-host only, localhost+relay: 3cx.com/docs/call-control-api , blog.3cx.com
- CRM integration (PRO; ReportCall journaling, lookup, click2call): https://www.3cx.com/docs/crm-integration/ , https://www.3cx.com/docs/crm-template-xml-description/
- Transfer/forwarding native + API: 3cx.com/docs (Web Client + Admin Console)
- WhatsApp coexistence (not 3CX-supported): 3cx.com/community Meta-coexistence thread; Meta Coexistence (May 2025)
- CDR / Call History / Data Connectors (16 SC+; direct DB unsupported): 3cx.com/docs CDR + /xapi/v1/CallHistoryView
- Supervisor (PRO) + Wallboard (PRO) + Recording (PRO; admin-lock Enterprise): 3cx.com/docs + blog
- 2026 editions / FUP / SC licensing: 3cx.com pricing + https://www.techmode.com/3cx-pricing-2026/

## 14. Files touched
- `recruitment-system/backend/src/routes/webhooks-3cx.js` (retarget + contact-lookup + socket emit)
- `recruitment-system/backend/src/config/migrations.js` (extension + call_logs columns)
- `recruitment-system/backend/scripts/seed-agents.js` / admin user-mgmt (15 agents + extension mapping)
- `recruitment-system/frontend/src/pages/Communications.jsx` (mount ClickToCall + `incoming_call`)
- `recruitment-system/backend/.env.example`, `docs/3cx-integration.md` (new)
- Reused: `utils/phone.js`, `services/claim-sessions.js`, `utils/websocket.js`, `components/ClickToCall.jsx`, `engagement.js`
