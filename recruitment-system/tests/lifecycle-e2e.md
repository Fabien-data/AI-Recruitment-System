# Lifecycle E2E walkthrough — recruitment-system overhaul v2

Manual end-to-end test executed locally before the single big-merge ships
to prod. Walks the new candidate lifecycle from chatbot intake all the
way through Selected/Rejected, plus verifies the project/job/interview
changes from earlier phases.

Run sequentially. Each step should match the expected outcome listed in
**bold**; any deviation blocks the merge.

## 0. Pre-flight

1. Pull the feature branch onto a clean clone:
   - `git checkout feat/recruitment-system-overhaul-v2`
   - `cd recruitment-system/backend && npm install`
   - `cd ../frontend && npm install`
2. Point the backend at a clone of the production database (do **not**
   run against prod itself). Set `.env` `DATABASE_URL` accordingly.
3. Start backend: `npm run dev` in `recruitment-system/backend`.
   - **Expected:** migration log line `migration: OK — applications.prescreening_completed_at` (and the rest of migration 022) appears in the startup output.
4. Start frontend: `npm run dev` in `recruitment-system/frontend`.

## 1. Project create — multi-industry + new benefits (Phase 1)

1. Sign in as an admin.
2. Click `New Project`.
3. Fill basic info; in the industry section, check `Security` and `IT Services`.
4. Toggle `Other`, type `Marine Services`, click `Add`. **Expected:** chip appears.
5. Pick countries `UAE` and `Saudi Arabia`.
6. In benefits, check `Medical Coverage`, `Meals included in salary`. Then check `Meals NOT included in salary`. **Expected:** "Meals included in salary" auto-clears (mutual exclusion).
7. Re-check `Meals included in salary`.
8. Submit. **Expected:** project appears in the Projects list with 3 industry chips (`Security`, `IT Services`, `Marine Services`).
9. Filter the Projects list by `Security`. **Expected:** the new project is included.

## 2. Project Detail UI/UX (Phase 2)

1. Open the new project.
2. **Expected:** gradient hero header with progress ring at 0%, industry chips, country flags, client name.
3. **Expected:** top stats grid shows `Total Jobs: 0`, `Candidates: 0`, `Applications: 0`, `Interviews: 0`, `Hired: 0`.
4. **Expected:** "Pipeline Status" sidebar lists `Applied 0`, `Certified 0`, `Pre Screened 0`, `Scheduled 0`, `Selected 0`, `Rejected 0`.

## 3. Job create — project linkage refresh (Phase 3)

1. From the Project Detail page, click `Add Job`.
2. Fill title `Security Guard`, category `security`, country `UAE`, domain `Middle East`, positions 5. Submit.
3. **Expected:** modal closes; the Jobs panel on the Project Detail page immediately shows the new job (no manual refresh).
4. **Expected:** the top stats grid `Total Jobs: 1`.
5. Click `View Candidates` on the new job.
6. **Expected:** the page renders cleanly (no "Job Not Found" red error). Empty-pipeline banner shown.
7. Click `Auto-Assign Now`. **Expected:** scan completes and candidates appear (or the empty state stays, but no error).

## 4. Edit job — no white page (Phase 4)

1. From the Jobs page or Project Detail, click the job's overflow menu → `Edit`.
2. Clear the `Application Deadline` field and any age/height numbers.
3. Save. **Expected:** modal closes with toast "Job updated". The page does **not** go blank.
4. Re-open Edit. **Expected:** form re-populates with the saved values (no garbage like "Wed Jan 01").
5. Trigger an artificial error: in DevTools network panel, throttle the response. Click Save. **Expected:** toast shows backend error, page stays usable. If anything crashes, the per-route ErrorBoundary's "Try again" button is visible — clicking it remounts the page.

## 5. Chatbot → Applied (Phase 8 + Phase 5)

1. Use the chatbot's WhatsApp sandbox (or POST manually to `/api/chatbot/intake`):
   ```json
   {
     "phone": "+94770000999",
     "name": "Test Candidate",
     "age": 27,
     "height_cm": 175,
     "preferred_language": "en",
     "job_interest": "Security Guard",
     "destination_country": "UAE",
     "skills": "patrol, cctv, customer service",
     "experience_years": 3,
     "cv_parsed_data": {
       "technical_skills": ["patrol", "cctv", "customer service"],
       "total_experience_years": 3
     }
   }
   ```
   with `x-chatbot-api-key` header set.
2. **Expected:** response 200/201 with `candidate_id` and `application_id` (because the stated job exists). Backend log line `Chatbot intake payload keys=...` is visible.
3. Open CV Manager. **Expected:** the new candidate card appears with age `27`, height `175`, skills tags, experience 3 years.
4. Open the candidate's review modal → tab labeled **`Applied Position`** (not `Projects`).
5. **Expected:** top card shows "Stated position from WhatsApp: Security Guard" and "Destination: UAE". Below, an existing application is listed.

## 6. Candidate lifecycle transitions (Phase 5)

From `Jobs → Security Guard → View Candidates`, for the test candidate:

1. Status pill should read `Applied`. Actions: `Certify`, `Transfer`, `Reject`.
2. Click `Certify`. Confirm. **Expected:** status flips to `Certified`. WhatsApp "you've been certified" message logged.
3. Action set now: `Mark Pre-Screened`, `Reject`.
4. Click `Mark Pre-Screened`. Set rating 4, write a note. Submit. **Expected:** status flips to `Pre Screened`. WhatsApp "you passed pre-screening" message logged.
5. Action set now: `Schedule Interview`, `Reject`.
6. Click `Schedule Interview`. Set date+time = tomorrow 9am, location = `Head Office`. Submit. **Expected:** status flips to `Scheduled`. New row in Interview Management. WhatsApp interview invitation logged.
7. Action set now: `Mark Selected`, `Reject`.
8. Click `Mark Selected`. **Expected:** status `Approved`. Project Detail "Hired" stat increments by 1.

Try an invalid jump:
- POST `/api/applications/<id>` with `{ "status": "selected" }` while the application is in `applied`. **Expected:** 400 with `Invalid lifecycle transition: applied → selected` message.

## 7. Card/Table toggle (Phase 6)

1. Visit `/jobs`. Click `Cards` then `Table` in the header toggle. **Expected:** rendering switches; filters and data are preserved. Refresh — last view persists.
2. Visit `/applications`. Same drill.

## 8. Interview Management — group by project, bulk notify (Phase 7)

1. Visit `/interviews`. **Expected:** project tabs at the top. The new project from step 1 is visible.
2. Click the project tab. **Expected:** only that project's interviews are shown.
3. Check the row(s) using the checkbox. **Expected:** floating action bar at the bottom shows count + "Send Interview Notification".
4. Click `Send Interview Notification`. **Expected:** WhatsApp re-sent; toast confirms. `confirmation_sent_at` timestamp updates in the DB.

## 9. Sanity scan

- Browse the dashboard, candidates list, general pool, communications page. **Expected:** no console errors, no white pages, all status badges render with the new color palette.
- Run `npm run lint` in both `backend` and `frontend`. **Expected:** no errors introduced by the overhaul.
- Run `/code-review high` on the diff against `main`. Address any new findings before merging.

## 10. Deploy (only after every step above passes)

Follow the chatbot deploy order from `memory/chatbot-deploy-order.md`:
1. Backend first → confirm migration 022 ran in Cloud Run logs.
2. `gcloud run services update-traffic` to promote the new revision.
3. Frontend → Firebase Hosting deploy.
4. Chatbot (Phase 8 touched it) → deploy + `update-traffic`.
5. Repeat steps 5-8 above against prod with a throwaway phone number.
6. If anything regresses, roll the failing service back via
   `gcloud run services update-traffic --to-revisions=PREV=100`.
