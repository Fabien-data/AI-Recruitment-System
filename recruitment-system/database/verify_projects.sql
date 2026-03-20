-- Quick verification queries to check your mock projects data

-- 1. Basic overview of all projects
SELECT * FROM projects ORDER BY id DESC;

-- 2. Projects summary with status
SELECT 
    id,
    title,
    client_name,
    industry_type,
    status,
    priority,
    total_positions,
    filled_positions,
    ROUND((filled_positions::decimal / total_positions * 100), 2) as completion_percentage
FROM projects 
ORDER BY priority DESC, total_positions DESC;

-- 3. Projects by status
SELECT 
    status,
    COUNT(*) as project_count,
    SUM(total_positions) as total_positions,
    SUM(filled_positions) as filled_positions
FROM projects 
GROUP BY status;

-- 4. Projects by industry
SELECT 
    industry_type,
    COUNT(*) as project_count,
    AVG(total_positions) as avg_positions
FROM projects 
GROUP BY industry_type
ORDER BY project_count DESC;