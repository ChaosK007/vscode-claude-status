import * as assert from 'assert';
import { buildLabel, buildTooltip, formatDuration } from '../../statusBar';
import { ClaudeUsageData } from '../../data/dataManager';

function makeData(overrides: Partial<ClaudeUsageData> = {}): ClaudeUsageData {
  return {
    utilization5h: 0.5,
    utilization7d: 0.3,
    resetIn5h: 3600,
    resetIn7d: 86400,
    limitStatus: 'allowed',
    has7dLimit: true,
    providerType: 'claude-ai',
    cost5h: 1.23,
    costDay: 2.50,
    cost7d: 10.00,
    tokensIn5h: 50_000,
    tokensOut5h: 10_000,
    tokensCacheRead5h: 5_000,
    tokensCacheCreate5h: 1_000,
    lastUpdated: new Date(),
    cacheAge: 30,
    dataSource: 'cache',
    // ===== CK-fork: required fields added to test fixture — 2026-05-16 =====
    model: 'claude-sonnet-4-6',
    ctxApproxUtil: 0.18,
    // ===== END CK-fork =====
    ...overrides,
  };
}

const mockProject = {
  projectName: 'my-app',
  projectPath: '/home/user/.claude/projects/-home-user-my-app',
  costToday: 3.21,
  cost7d: 18.45,
  cost30d: 62.10,
  sessionCount: 5,
  lastActive: new Date(),
};

suite('formatDuration', () => {
  test('returns minutes for < 1 hour', () => {
    assert.strictEqual(formatDuration(600), '10m');
    assert.strictEqual(formatDuration(3540), '59m');
  });

  test('returns hours for 1h-23h', () => {
    assert.strictEqual(formatDuration(3600), '1h');
    assert.strictEqual(formatDuration(5400), '1h 30m');
    assert.strictEqual(formatDuration(82800), '23h');
  });

  test('returns days for >= 24h', () => {
    assert.strictEqual(formatDuration(86400), '1d');
    assert.strictEqual(formatDuration(90000), '1d 1h');
    assert.strictEqual(formatDuration(172800), '2d');
  });
});

suite('StatusBar', () => {
  // ===== CK-fork: updated assertions for changed label format — 2026-05-16 =====
  // Original upstream: labels started with '🤖 '; CK fork removes the emoji prefix.
  test('buildLabel shows not-logged-in for no-credentials', () => {
    const label = buildLabel(makeData({ dataSource: 'no-credentials' }));
    // Original: assert.strictEqual(label, '🤖 Not logged in');
    assert.ok(label.includes('not logged in'), `Expected not-logged-in in: ${label}`);
  });

  test('buildLabel shows run-refresh for no-data', () => {
    const label = buildLabel(makeData({ dataSource: 'no-data' }));
    // Original: assert.strictEqual(label, '🤖 Claude: run refresh');
    assert.ok(label.includes('run refresh'), `Expected run-refresh in: ${label}`);
  });

  test('buildLabel shows denied with ✗ indicator', () => {
    const label = buildLabel(makeData({ limitStatus: 'denied', dataSource: 'cache' }));
    assert.ok(label.includes('✗'), `Expected ✗ in: ${label}`);
  });

  test('buildLabel shows bar (not plain %) when utilization >= 75%', () => {
    // CK-fork: inline ⚠ markers removed; color coding via applyColor() instead.
    // Original: assert.ok(label.includes('⚠'), ...);
    const label = buildLabel(makeData({
      utilization5h: 0.80,
      limitStatus: 'allowed_warning',
      dataSource: 'cache',
    }));
    assert.ok(label.includes('█'), `Expected bar chars in: ${label}`);
  });
  // ===== END CK-fork =====

  test('buildLabel shows stale age suffix for stale data (minutes)', () => {
    const label = buildLabel(makeData({ dataSource: 'stale', cacheAge: 600 }));
    assert.ok(label.includes('10m ago'), `Expected stale suffix in: ${label}`);
  });

  test('buildLabel shows stale age in hours for stale data > 1h', () => {
    const label = buildLabel(makeData({ dataSource: 'stale', cacheAge: 7200 }));
    assert.ok(label.includes('2h ago'), `Expected 2h ago in: ${label}`);
  });

  test('buildLabel shows stale age in days for stale data > 24h', () => {
    const label = buildLabel(makeData({ dataSource: 'stale', cacheAge: 172800 }));
    assert.ok(label.includes('2d ago'), `Expected 2d ago in: ${label}`);
  });

  test('buildLabel includes project cost when project data is present', () => {
    const label = buildLabel(makeData({ dataSource: 'cache' }), [mockProject]);
    assert.ok(label.includes('my-app'), `Expected project name in: ${label}`);
    assert.ok(label.includes('$3.21'), `Expected project cost in: ${label}`);
  });

  test('buildLabel shows PJ aggregate for multi-root workspaces', () => {
    const second = { ...mockProject, projectName: 'other-app', costToday: 1.00 };
    const label = buildLabel(makeData({ dataSource: 'cache' }), [mockProject, second]);
    assert.ok(label.includes('PJ:'), `Expected PJ: prefix in: ${label}`);
    assert.ok(label.includes('$4.21'), `Expected aggregate cost in: ${label}`);
  });

  test('buildLabel omits project part when no project costs', () => {
    const label = buildLabel(makeData({ dataSource: 'cache' }), []);
    assert.ok(!label.includes('|'), `Expected no | separator in: ${label}`);
  });

  test('buildTooltip includes utilization percentages', () => {
    const tooltip = buildTooltip(makeData({ utilization5h: 0.5, utilization7d: 0.3 }));
    assert.ok(tooltip.includes('50%'), `Expected 50% in tooltip`);
    assert.ok(tooltip.includes('30%'), `Expected 30% in tooltip`);
  });

  test('buildTooltip shows project breakdown when data provided', () => {
    const tooltip = buildTooltip(makeData({ dataSource: 'cache' }), [mockProject]);
    assert.ok(tooltip.includes('my-app'), `Expected project name in tooltip`);
    assert.ok(tooltip.includes('$3.21'), `Expected project cost in tooltip`);
  });

  test('buildTooltip shows no-credentials message', () => {
    const tooltip = buildTooltip(makeData({ dataSource: 'no-credentials' }));
    assert.ok(tooltip.includes('not logged in') || tooltip.includes('Not logged'), tooltip);
  });
});
