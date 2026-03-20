-- Migration: Add Projects Management System
-- Date: 2026-02-16
-- Description: Adds projects table, project_assignments table, and links jobs to projects

-- ===============================================
-- POSTGRESQL VERSION
-- ===============================================

-- Create projects table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    client_name TEXT NOT NULL,
    industry_type TEXT NOT NULL,
    description TEXT,
    countries JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT DEFAULT 'planning',
    priority TEXT DEFAULT 'normal',
    total_positions INTEGER DEFAULT 0,
    filled_positions INTEGER DEFAULT 0,
    start_date DATE,
    interview_date DATE,
    end_date DATE,
    benefits JSONB DEFAULT '{}'::jsonb,
    salary_info JSONB DEFAULT '{}'::jsonb,
    contact_info JSONB DEFAULT '{}'::jsonb,
    requirements JSONB DEFAULT '{}'::jsonb,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_priority ON projects(priority);
CREATE INDEX IF NOT EXISTS idx_projects_client_name ON projects(client_name);
CREATE INDEX IF NOT EXISTS idx_projects_interview_date ON projects(interview_date);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_industry ON projects(industry_type);

-- Create project_assignments table
CREATE TABLE IF NOT EXISTS project_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_assignments_unique ON project_assignments(project_id, user_id, role);
CREATE INDEX IF NOT EXISTS idx_project_assignments_project ON project_assignments(project_id);
CREATE INDEX IF NOT EXISTS idx_project_assignments_user ON project_assignments(user_id);

-- Add project_id to jobs table
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);

-- ===============================================
-- MYSQL VERSION (Comment out PostgreSQL above and use this for MySQL)
-- ===============================================

/*
-- Create projects table
CREATE TABLE IF NOT EXISTS projects (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    title VARCHAR(255) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    industry_type VARCHAR(100) NOT NULL,
    description TEXT,
    countries JSON NOT NULL DEFAULT ('[]'),
    status VARCHAR(50) DEFAULT 'planning',
    priority VARCHAR(50) DEFAULT 'normal',
    total_positions INT DEFAULT 0,
    filled_positions INT DEFAULT 0,
    start_date DATE,
    interview_date DATE,
    end_date DATE,
    benefits JSON DEFAULT ('{}'),
    salary_info JSON DEFAULT ('{}'),
    contact_info JSON DEFAULT ('{}'),
    requirements JSON DEFAULT ('{}'),
    metadata JSON DEFAULT ('{}'),
    created_by CHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_projects_status (status),
    INDEX idx_projects_priority (priority),
    INDEX idx_projects_client_name (client_name),
    INDEX idx_projects_interview_date (interview_date),
    INDEX idx_projects_industry (industry_type),
    INDEX idx_projects_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- Create project_assignments table
CREATE TABLE IF NOT EXISTS project_assignments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    project_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    role VARCHAR(50) NOT NULL,
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by CHAR(36),
    UNIQUE KEY unique_project_user_role (project_id, user_id, role),
    INDEX idx_proj_assign_project (project_id),
    INDEX idx_proj_assign_user (user_id),
    INDEX idx_proj_assign_tenant (tenant_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- Add project_id column to jobs table (if not exists)
ALTER TABLE jobs ADD COLUMN project_id CHAR(36) NULL;
ALTER TABLE jobs ADD INDEX idx_jobs_project (project_id);
ALTER TABLE jobs ADD CONSTRAINT fk_jobs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
*/

-- ===============================================
-- ROLLBACK (if needed)
-- ===============================================

/*
-- PostgreSQL Rollback:
DROP INDEX IF EXISTS idx_jobs_project;
ALTER TABLE jobs DROP COLUMN IF EXISTS project_id;
DROP TABLE IF EXISTS project_assignments;
DROP TABLE IF EXISTS projects;

-- MySQL Rollback:
ALTER TABLE jobs DROP FOREIGN KEY fk_jobs_project;
ALTER TABLE jobs DROP INDEX idx_jobs_project;
ALTER TABLE jobs DROP COLUMN project_id;
DROP TABLE IF EXISTS project_assignments;
DROP TABLE IF EXISTS projects;
*/
