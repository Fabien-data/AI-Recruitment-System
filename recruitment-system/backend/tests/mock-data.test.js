const mockData = require('../src/routes/mock-data');

describe('mock-data route exports', () => {
  test('exports mockCandidates array with expected shape', () => {
    expect(Array.isArray(mockData.mockCandidates)).toBe(true);
    expect(mockData.mockCandidates.length).toBeGreaterThan(0);
    const candidate = mockData.mockCandidates[0];
    expect(candidate).toHaveProperty('name');
    expect(candidate).toHaveProperty('phone');
    expect(candidate).toHaveProperty('cv_text');
  });

  test('exports mockProjects array with expected shape', () => {
    expect(Array.isArray(mockData.mockProjects)).toBe(true);
    expect(mockData.mockProjects.length).toBeGreaterThan(0);
    const project = mockData.mockProjects[0];
    expect(project).toHaveProperty('title');
    expect(project).toHaveProperty('category');
    expect(project).toHaveProperty('positions_available');
  });
});
