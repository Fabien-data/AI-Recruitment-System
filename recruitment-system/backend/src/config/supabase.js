/**
 * Supabase Client Configuration
 * 
 * This file provides a Supabase client for querying the new "Place A" database.
 * The n8n workflows write data here, and the dashboard reads from here.
 */

const { createClient } = require('@supabase/supabase-js');

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Validate configuration
if (!supabaseUrl) {
    console.warn('⚠️ SUPABASE_URL not configured. Supabase features will be disabled.');
}

// Create Supabase client with service role (for server-side operations)
const supabaseAdmin = supabaseUrl && supabaseServiceKey
    ? createClient(supabaseUrl, supabaseServiceKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false
        }
    })
    : null;

// Create Supabase client with anon key (for client-side compatible operations)
const supabase = supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

/**
 * Check if Supabase is configured and available
 */
const isSupabaseConfigured = () => {
    return supabaseUrl && supabaseServiceKey;
};

/**
 * Get all candidates from Supabase (Place A)
 * @param {Object} options - Query options
 * @param {string} options.status - Filter by status
 * @param {string} options.source - Filter by source (whatsapp, gmail)
 * @param {number} options.limit - Limit results
 * @param {number} options.offset - Offset for pagination
 */
const getCandidates = async (options = {}) => {
    if (!supabaseAdmin) {
        throw new Error('Supabase not configured');
    }

    let query = supabaseAdmin
        .from('raw_candidates')
        .select('*')
        .order('created_at', { ascending: false });

    if (options.status) {
        query = query.eq('status', options.status);
    }
    if (options.source) {
        query = query.eq('source', options.source);
    }
    if (options.limit) {
        query = query.limit(options.limit);
    }
    if (options.offset) {
        query = query.range(options.offset, options.offset + (options.limit || 10) - 1);
    }

    const { data, error, count } = await query;
    
    if (error) {
        throw error;
    }

    return { data, count };
};

/**
 * Get candidate by ID from Supabase
 * @param {string} candidateId - UUID of the candidate
 */
const getCandidateById = async (candidateId) => {
    if (!supabaseAdmin) {
        throw new Error('Supabase not configured');
    }

    const { data, error } = await supabaseAdmin
        .from('raw_candidates')
        .select(`
            *,
            cv_files (*),
            conversations (*)
        `)
        .eq('id', candidateId)
        .single();

    if (error) {
        throw error;
    }

    return data;
};

/**
 * Get CV files for a candidate
 * @param {string} candidateId - UUID of the candidate
 */
const getCVFiles = async (candidateId) => {
    if (!supabaseAdmin) {
        throw new Error('Supabase not configured');
    }

    const { data, error } = await supabaseAdmin
        .from('cv_files')
        .select('*')
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: false });

    if (error) {
        throw error;
    }

    return data;
};

/**
 * Get conversation history for a candidate
 * @param {string} candidateId - UUID of the candidate
 * @param {number} limit - Max conversations to return
 */
const getConversations = async (candidateId, limit = 50) => {
    if (!supabaseAdmin) {
        throw new Error('Supabase not configured');
    }

    const { data, error } = await supabaseAdmin
        .from('conversations')
        .select('*')
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: false })
        .limit(limit);

    if (error) {
        throw error;
    }

    return data;
};

/**
 * Get dashboard statistics from Supabase
 */
const getDashboardStats = async () => {
    if (!supabaseAdmin) {
        throw new Error('Supabase not configured');
    }

    // Get total candidates by status
    const { data: statusCounts, error: statusError } = await supabaseAdmin
        .from('raw_candidates')
        .select('status', { count: 'exact' });

    // Get candidates by source
    const { data: sourceCounts, error: sourceError } = await supabaseAdmin
        .from('raw_candidates')
        .select('source', { count: 'exact' });

    // Get recent candidates (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const { data: recentCandidates, error: recentError } = await supabaseAdmin
        .from('raw_candidates')
        .select('*', { count: 'exact' })
        .gte('created_at', sevenDaysAgo.toISOString());

    if (statusError || sourceError || recentError) {
        throw statusError || sourceError || recentError;
    }

    return {
        total_candidates: statusCounts?.length || 0,
        recent_candidates: recentCandidates?.length || 0,
        by_status: statusCounts,
        by_source: sourceCounts
    };
};

/**
 * Search candidates by name, phone, or email
 * @param {string} searchTerm - Search query
 */
const searchCandidates = async (searchTerm) => {
    if (!supabaseAdmin) {
        throw new Error('Supabase not configured');
    }

    const { data, error } = await supabaseAdmin
        .from('raw_candidates')
        .select('*')
        .or(`phone.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%,parsed_cv_data->full_name.ilike.%${searchTerm}%`)
        .order('created_at', { ascending: false })
        .limit(50);

    if (error) {
        throw error;
    }

    return data;
};

/**
 * Get workflow logs for monitoring
 * @param {Object} options - Query options
 */
const getWorkflowLogs = async (options = {}) => {
    if (!supabaseAdmin) {
        throw new Error('Supabase not configured');
    }

    let query = supabaseAdmin
        .from('workflow_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(options.limit || 100);

    if (options.workflow_name) {
        query = query.eq('workflow_name', options.workflow_name);
    }
    if (options.status) {
        query = query.eq('status', options.status);
    }

    const { data, error } = await query;

    if (error) {
        throw error;
    }

    return data;
};

module.exports = {
    supabase,
    supabaseAdmin,
    isSupabaseConfigured,
    getCandidates,
    getCandidateById,
    getCVFiles,
    getConversations,
    getDashboardStats,
    searchCandidates,
    getWorkflowLogs
};
