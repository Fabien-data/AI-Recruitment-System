
-- Create default admin user
-- Password: admin123
-- Email: admin@recruitment.com

INSERT INTO users (email, password_hash, full_name, role, is_active)
VALUES (
    'admin@recruitment.com',
    '$2b$10$YourHashedPasswordHere',  -- This will be replaced by the actual hash
    'Admin User',
    'admin',
    true
)
ON CONFLICT (email) DO NOTHING;

-- Note: You'll need to hash the password first using bcrypt
-- Or use the registration API endpoint to create the user
