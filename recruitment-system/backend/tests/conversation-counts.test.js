// Unit tests for the shared conversation-counts builder — the single definition
// of "which candidates the Conversations panel counts, and how they're bucketed"
// that BOTH /active-chats(/counts) and /api/applications/status-totals import, so
// the Messages tab badges and the Applications candidate-by-stage strip can't drift.

const {
    buildConversationFilters,
    buildCandidateStatusCountsSql,
    shapeCountsRow,
} = require('../src/services/conversation-counts');

// Minimal addParam stub mirroring the route closures (Postgres placeholders).
function makeAddParam() {
    const params = [];
    const addParam = (v) => { params.push(v); return `$${params.length}`; };
    addParam.params = params;
    return addParam;
}

describe('buildConversationFilters', () => {
    test('always applies the WhatsApp conversation gate (badges == list population)', () => {
        const filters = buildConversationFilters({ query: {}, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: false });
        expect(filters).toContain('lm.sent_at IS NOT NULL');
    });

    test('list mode (includeStatusBucket=true) applies the single status bucket', () => {
        const filters = buildConversationFilters({ query: { status: 'screening' }, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: true });
        expect(filters.some((f) => f.includes("LOWER(COALESCE(ca.status, 'new')) ="))).toBe(true);
    });

    test('counts mode (includeStatusBucket=false) omits the single status bucket (it fans out per bucket)', () => {
        const filters = buildConversationFilters({ query: { status: 'screening' }, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: false });
        expect(filters.some((f) => f.includes("LOWER(COALESCE(ca.status, 'new')) ="))).toBe(false);
    });

    test('a search is GLOBAL — it bypasses the status bucket and project scope', () => {
        const filters = buildConversationFilters({
            query: { search: '0771', status: 'screening', project_id: 'p1' },
            userId: 'u1', addParam: makeAddParam(), includeStatusBucket: true,
        });
        expect(filters.some((f) => f.includes('ILIKE'))).toBe(true);
        expect(filters.some((f) => f.includes("LOWER(COALESCE(ca.status, 'new')) ="))).toBe(false);
        expect(filters.some((f) => f.includes('COALESCE(la.project_id, adt.project_id) ='))).toBe(false);
    });

    test("project_id='unassigned' scopes to no effective project", () => {
        const filters = buildConversationFilters({ query: { project_id: 'unassigned' }, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: false });
        expect(filters).toContain('COALESCE(la.project_id, adt.project_id) IS NULL');
    });

    test('project_id scopes on the effective project and binds a param', () => {
        const addParam = makeAddParam();
        const filters = buildConversationFilters({ query: { project_id: 'p-123' }, userId: 'u1', addParam, includeStatusBucket: false });
        expect(filters.some((f) => f.includes('COALESCE(la.project_id, adt.project_id) = $'))).toBe(true);
        expect(addParam.params).toContain('p-123');
    });

    // Default claim scope (no explicit claimed filter): claimed chats are hidden
    // from the NEW list ONLY — All chats + every other status tab keep them
    // (user decision 2026-06-15).
    test("default claim scope hides claimed chats from the New list", () => {
        const filters = buildConversationFilters({ query: { status: 'new' }, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: true });
        expect(filters).toContain('ca.claimed_by IS NULL');
    });

    test("default claim scope KEEPS claimed chats in the All-chats list (no status)", () => {
        const filters = buildConversationFilters({ query: {}, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: true });
        expect(filters).not.toContain('ca.claimed_by IS NULL');
    });

    test("default claim scope KEEPS claimed chats in a non-New status list (e.g. certified)", () => {
        const filters = buildConversationFilters({ query: { status: 'certified' }, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: true });
        expect(filters).not.toContain('ca.claimed_by IS NULL');
    });

    test("counts mode never adds the WHERE-level claim gate (it fans out per bucket via hideClaimedFromNew)", () => {
        const filters = buildConversationFilters({ query: { status: 'new' }, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: false });
        expect(filters).not.toContain('ca.claimed_by IS NULL');
    });

    test("claimed='me' scopes to the user's own chats regardless of bucket", () => {
        const addParam = makeAddParam();
        const filters = buildConversationFilters({ query: { claimed: 'me', status: 'new' }, userId: 'u-42', addParam, includeStatusBucket: true });
        expect(filters.some((f) => /ca\.claimed_by = \$/.test(f))).toBe(true);
        expect(addParam.params).toContain('u-42');
        expect(filters).not.toContain('ca.claimed_by IS NULL');
    });

    test("claimed='unassigned' scopes to unclaimed chats", () => {
        const filters = buildConversationFilters({ query: { claimed: 'unassigned' }, userId: 'u1', addParam: makeAddParam(), includeStatusBucket: true });
        expect(filters).toContain('ca.claimed_by IS NULL');
    });
});

describe('buildCandidateStatusCountsSql', () => {
    const sql = buildCandidateStatusCountsSql({ whereClause: 'WHERE lm.sent_at IS NOT NULL' });

    test('emits every canonical Messages bucket', () => {
        ['st_new', 'st_screening', 'st_certified', 'st_interview_scheduled', 'st_future_pool'].forEach((alias) => {
            expect(sql).toContain(alias);
        });
    });

    test('omits hired by default, includes it when requested (Applications strip)', () => {
        expect(sql).not.toContain('st_hired');
        const withHired = buildCandidateStatusCountsSql({ whereClause: '', includeHired: true });
        expect(withHired).toContain('st_hired');
    });

    test('counts over the same FROM/JOIN population as the list (lm gate join present)', () => {
        expect(sql).toContain('FROM candidates ca');
        // The latest-message lateral filters whatsapp messages (alias c2 after the
        // DISTINCT-ON → LATERAL rewrite for the indexed top-1-per-candidate lookup).
        expect(sql).toContain("c2.channel = 'whatsapp'");
        expect(sql).toContain('LEFT JOIN LATERAL');
    });

    // hideClaimedFromNew gates ONLY the New badge (user decision 2026-06-15): the
    // New count drops claimed chats to mirror the New list, while total_chats and
    // every other status badge keep claimed chats so the pipeline reads in full.
    test('default (hideClaimedFromNew=false) leaves the New bucket unfiltered by claim', () => {
        expect(sql).toMatch(/FILTER \(WHERE LOWER\(COALESCE\(ca\.status,'new'\)\) = 'new'\) AS st_new/);
    });

    test('hideClaimedFromNew=true gates only the New bucket on claimed_by IS NULL', () => {
        const gated = buildCandidateStatusCountsSql({ whereClause: '', hideClaimedFromNew: true });
        expect(gated).toMatch(/FILTER \(WHERE LOWER\(COALESCE\(ca\.status,'new'\)\) = 'new' AND ca\.claimed_by IS NULL\) AS st_new/);
        // Other buckets must NOT carry the claim clause.
        expect(gated).toMatch(/FILTER \(WHERE LOWER\(COALESCE\(ca\.status,'new'\)\) = 'screening'\) AS st_screening/);
        expect(gated).toMatch(/FILTER \(WHERE LOWER\(COALESCE\(ca\.status,'new'\)\) = 'certified'\) AS st_certified/);
        // total_chats keeps claimed chats too.
        expect(gated).toContain('COUNT(*) AS total_chats');
    });
});

describe('shapeCountsRow', () => {
    test('maps st_* aggregates into by_status, coercing nulls to 0', () => {
        const out = shapeCountsRow({ total_chats: '7', bot_controlled: '5', human_controlled: '2', cv_uploaded: '3', st_new: '1', st_screening: '4', st_certified: null });
        expect(out.total_chats).toBe(7);
        expect(out.by_status.new).toBe(1);
        expect(out.by_status.screening).toBe(4);
        expect(out.by_status.certified).toBe(0);
        expect(out.by_status.hired).toBeUndefined();
    });

    test('includeHired surfaces the hired bucket', () => {
        const out = shapeCountsRow({ st_hired: '9' }, { includeHired: true });
        expect(out.by_status.hired).toBe(9);
    });
});
