module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    testTimeout: 60000, // 60 seconds for API calls
    verbose: true,
    collectCoverage: false,
    setupFiles: ['dotenv/config'],
    modulePathIgnorePatterns: ['<rootDir>/node_modules/'],
    // Don't run tests in parallel to avoid rate limiting
    maxWorkers: 1
};
