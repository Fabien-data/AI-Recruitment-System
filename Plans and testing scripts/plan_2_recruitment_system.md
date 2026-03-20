# Plan 2 — Recruitment System: UI/UX Makeover & Feature Improvements

## Background

The recruitment system is a Node.js/Express backend + React/Vite/Tailwind frontend with PostgreSQL. It receives candidates from the WhatsApp chatbot and manages the full recruitment pipeline. The user wants a **modern blue-themed UI** with **rich dashboard visualizations**, **functioning CV features**, **AI insights**, and **smooth animations** — preserving all existing functionality.

---

## Current State Summary

### Frontend Pages (16 pages)

| Page | File | Key Issues |
|---|---|---|
| Dashboard | [Dashboard.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/pages/Dashboard.jsx) | No charts, boring stat cards, no quick actions |
| CV Manager | [CVManager.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/pages/CVManager.jsx) | PDF viewer may not work, AI insights are shallow |
| Job Candidates | [JobCandidates.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/pages/JobCandidates.jsx) | No alternative job suggestions, no critical mismatch highlights |
| Analytics | [Analytics.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/pages/Analytics.jsx) | Basic charts, needs expansion |
| Layout | [Layout.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/components/Layout.jsx) | White sidebar, no gradient, no animation |
| All pages | — | Indigo color theme instead of blue, basic loading states |

### Current Theme vs Target

| | Current | Target |
|---|---|---|
| Primary color | Indigo `#6366f1` | Blue `#3b82f6` |
| Sidebar | Plain white | Deep navy-to-blue gradient with glassmorphism |
| Dashboard | 4 stat cards + list | Charts + animated KPIs + quick actions |
| Animations | Skeleton pulse only | Page transitions + stagger + hover micro-animations |

---

## SECTION A: Blue Theme Conversion

### [MODIFY] [tailwind.config.js](file:///d:/Dewan%20Project/recruitment-system/frontend/tailwind.config.js)

Replace the indigo primary palette with a curated blue family:

```js
primary: {
  50:  '#eff6ff',
  100: '#dbeafe',
  200: '#bfdbfe',
  300: '#93c5fd',
  400: '#60a5fa',
  500: '#3b82f6',   // main brand blue
  600: '#2563eb',   // primary CTA
  700: '#1d4ed8',   // hover
  800: '#1e40af',   // active
  900: '#1e3a8a',   // dark
  950: '#172554',   // darkest — sidebar gradient end
},
```

Add custom animation tokens, glassmorphism background gradients, and CSS keyframes for `fade-in`, `slide-up`, `slide-in`, `pulse-soft`, and an animated counter effect.

---

### [MODIFY] [index.css](file:///d:/Dewan%20Project/recruitment-system/frontend/src/index.css)

- Update `--color-primary` to `59 130 246` (blue-500)
- Update `.btn-primary` → `bg-blue-600 hover:bg-blue-700`
- Add `.glass` utility (backdrop-filter blur + translucent white background)
- Add `.page-enter` animation class for page mount
- Add `.stagger > *:nth-child(n)` classes for list stagger delays
- Add `.card` hover shadow with a blue-tinted glow

---

## SECTION B: Sidebar & Layout Redesign

### [MODIFY] [Layout.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/components/Layout.jsx)

**Sidebar changes:**
- Replace white background with `bg-gradient-to-b from-blue-950 via-blue-800 to-blue-600`
- Nav links: white/blue-100 text on dark background; active state uses `glass` (frosted glass pill)
- Logo: subtle glow effect
- User card at bottom: glass card styling with white text

**Header bar (desktop):**
- Add a top header with: current page title, notification bell icon (with animated red dot), user avatar
- Bell icon shows count of new candidates / upcoming interviews

**Mobile:**
- Hamburger icon → animated ×-icon on open
- Overlay backdrop: `bg-blue-950/60 backdrop-blur-sm`

---

## SECTION C: Dashboard — Rich Visualizations

> [!IMPORTANT]
> Run `npm install recharts` in `recruitment-system/frontend/` before implementing this section.

### [MODIFY] [Dashboard.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/pages/Dashboard.jsx)

**New layout structure:**

```
Row 1: [Animated KPI Cards × 4]
Row 2: [Pipeline Funnel (60%)] [Source Donut (40%)]
Row 3: [Hiring Trend Area Chart (full width)]
Row 4: [Top Jobs Bar Chart (60%)] [Upcoming Interviews (40%)]
Row 5: [Quick Action Buttons]
```

**Charts to implement:**

1. **Animated KPI Cards** — stat cards with `AnimatedNumber` counter and ±% trend indicator arrows
2. **Pipeline Funnel** — `FunnelChart` from Recharts: New → Screening → Interview → Selected → Hired (shades of blue deepening at each step)
3. **Source Distribution Donut** — `PieChart` with `innerRadius`: shows WhatsApp / Email / Walk-in / Other split in blue tones
4. **Hiring Trend** — `AreaChart` with a blue gradient fill: applications vs placed per month (last 6 months)
5. **Top Jobs by Applications** — `BarChart` horizontal: top 5 active jobs ranked by application count

**Quick Action Buttons (bottom row):**
- `+ Add Candidate` → link to candidate create
- `+ Add Job` → opens CreateJobModal
- `🤖 Batch Auto-Assign` → triggers batch auto-assign API
- `📊 Export Report` → future feature placeholder

**Data sourcing:**
- Most data already fetched via `getAnalyticsOverview()`, `getCandidates()`, `getJobs()`, `getApplications()`
- Pipeline data: group applications by status
- Source data: group candidates by source
- Trend data: group by `created_at` month (last 6 months)

---

## SECTION D: CV Manager — Three Critical Fixes

### [MODIFY] [CVManager.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/pages/CVManager.jsx)

**Fix 1 — PDF Viewer:**
```jsx
// In OverviewTab, after candidate profile info:
{candidate.cv_url && (
  <div className="border border-blue-100 rounded-xl overflow-hidden h-96 bg-blue-50">
    {candidate.cv_type === 'image' 
      ? <img src={candidate.cv_url} alt="CV" className="w-full h-full object-contain" />
      : <iframe src={`${candidate.cv_url}#toolbar=0`} className="w-full h-full" title="CV Preview" />
    }
  </div>
)}
```

**Fix 2 — Download Button:**
```jsx
<a href={candidate.cv_url} download={`CV_${candidate.name}`} target="_blank"
   className="btn btn-primary flex items-center gap-2 w-full justify-center">
  <Download size={16} /> Download CV
</a>
```

**Fix 3 — AI Insights Tab (new):**
- New `AIInsightsTab` component alongside Overview / Remarks / Applications / Allocate
- Shows: circular match score gauge, critical mismatches (red alerts with field + reason), strengths (green checkmarks), and the `AlternativeJobsPanel`

---

## SECTION E: Job Candidates — Key Feature Additions

### [MODIFY] [JobCandidates.jsx](file:///d:/Dewan%20Project/recruitment-system/frontend/src/pages/JobCandidates.jsx)

**Addition 1 — Critical Mismatch Badge on CandidateRow:**
```jsx
const criticalMismatches = (data.candidate?.metadata?.mismatches || [])
  .filter(m => m.severity === 'critical')

{criticalMismatches.length > 0 && (
  <span className="flex items-center gap-1 text-xs font-medium text-red-600 
                   bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
    <AlertTriangle size={11} /> {criticalMismatches.length} critical mismatch
  </span>
)}
```

**Addition 2 — "Also Suitable For" panel inside CandidateQuickViewModal:**

New `AlternativeJobsPanel` component:
- Queries `GET /api/auto-assign/candidate/:id/alternatives` (new backend endpoint)
- Displays top 3 alternative jobs with: job title, project name, match %, and a one-line reason
- Score color: green ≥70%, amber ≥50%, gray <50%
- "Assign to this job →" shortcut button on each alternative

### [MODIFY] [auto-assign.js](file:///d:/Dewan%20Project/recruitment-system/backend/src/routes/auto-assign.js) — New Endpoint

```js
// GET /api/auto-assign/candidate/:id/alternatives?threshold=40
// Returns top 3 jobs (excluding current) sorted by match score with reasons
router.get('/candidate/:id/alternatives', authenticateToken, async (req, res) => {
    // 1. Fetch candidate's CV data and extracted skills/experience from DB
    // 2. Fetch all active jobs (exclude jobs candidate already applied for)
    // 3. Run the existing compatibility scoring for each job
    // 4. Build "reason" string from top matching criteria
    // 5. Return top 3 sorted by score descending
    res.json({ alternatives: [...] })
})
```

---

## SECTION F: System-Wide Animations

### All 16 page files — minor additions each

**Pattern 1: Page entry animation**
```jsx
// Every page root element:
<div className="p-6 lg:p-8 animate-fade-in">
```

**Pattern 2: List stagger**
```jsx
// Tables and card grids:
<div className="grid grid-cols-3 gap-4 stagger">
  {items.map(item => <Card key={item.id} className="animate-slide-up" />)}
</div>
```

**Pattern 3: Animated loading spinners**
```jsx
// Replace plain text loaders with:
<div className="flex items-center justify-center py-12">
  <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
</div>
```

**Pattern 4: Button loading state**
```jsx
{isLoading
  ? <><Loader2 size={16} className="animate-spin" /> Processing...</>
  : label
}
```

**Pattern 5: Hover scale on cards**
```jsx
<div className="card hover:scale-[1.01] hover:shadow-lg transition-all duration-200">
```

---

## SECTION G: CRUD Verification Checklist

| Entity | Create | Read/List | Update | Delete |
|---|---|---|---|---|
| Candidates | `POST /api/candidates` | `GET /api/candidates` | `PUT /api/candidates/:id` | `DELETE /api/candidates/:id` |
| Jobs | `POST /api/jobs` | `GET /api/jobs` | `PUT /api/jobs/:id` | `DELETE /api/jobs/:id` |
| Projects | `POST /api/projects` | `GET /api/projects` | `PUT /api/projects/:id` | `DELETE /api/projects/:id` |
| Applications | `POST /api/applications` | `GET /api/applications` | `PUT /api/applications/:id` | reject-to-pool = soft delete |
| Interviews | `POST /api/interviews` | `GET /api/interviews` | `PUT /api/interviews/:id` | `DELETE /api/interviews/:id` |
| Communications | `POST /api/communications/send` | `GET /api/communications/candidate/:id` | — | — |

**Priority fixes to check:**
1. **Job create form** (`CreateJobModal`) — must link to a Project (required FK) — verify project dropdown populates
2. **Candidate tags** — `updateCandidate()` with `tags` array must persist correctly
3. **Application status transitions** — verify `applied → screening → certified → interview_scheduled → selected` all update correctly
4. **CV file upload** — verify `cv_url` field is populated after chatbot sync, not just local file path

---

## Packages to Install

```bash
cd d:\Dewan Project\recruitment-system\frontend
npm install recharts
```

---

## Estimated Effort

| Section | Time |
|---|---|
| A + B: Blue theme + Layout redesign | 6h |
| C: Dashboard visualizations | 6h |
| D: CV Manager fixes | 4h |
| E: Job Candidates + backend endpoint | 5h |
| F: Animations across 16 pages | 5h |
| G: CRUD verification + fixes | 4h |
| **Total** | **~30h** |
