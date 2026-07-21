/**
 * v0.1 dogfood 场景：5 小修复 + 3 普通功能 + 2 确定性 riskTrigger。
 */

export type ScenarioKind = 'fix' | 'feature' | 'risk';

export type SimulatedTool = {
  tool: 'read' | 'write' | 'edit' | 'bash';
  path?: string;
  command?: string;
  content?: string;
};

export type Scenario = {
  id: string;
  kind: ScenarioKind;
  intent: string;
  /** /run 到首次 write|edit 之前的工具调用（含首次编辑本身之前的次数） */
  toolsBeforeFirstEdit: SimulatedTool[];
  /** 首次及后续写操作 */
  edits: SimulatedTool[];
  expect: {
    riskAfterEdits: 'lean' | 'guarded';
    gateTrigger?:
      | 'databaseMigration'
      | 'dependencyChange'
      | 'protectedPaths'
      | 'dangerousCommand';
    /** lean 任务不得产生仓库 record */
    artifactCount: number;
    /** lean 任务不得残留未解决 gate */
    openGate: boolean;
  };
};

export const SCENARIOS: Scenario[] = [
  // --- 5 small fixes ---
  {
    id: 'fix-01-redirect-query',
    kind: 'fix',
    intent: '修复登录后 redirect 丢失 query 参数',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'src/auth/redirect.ts' },
      { tool: 'read', path: 'src/auth/redirect.test.ts' },
    ],
    edits: [
      { tool: 'edit', path: 'src/auth/redirect.ts' },
      { tool: 'edit', path: 'src/auth/redirect.test.ts' },
    ],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
    },
  },
  {
    id: 'fix-02-avatar-cache',
    kind: 'fix',
    intent: '修复退出登录后仍显示旧头像',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'src/auth/logout.ts' },
      { tool: 'bash', command: 'rg -n avatar src/auth' },
    ],
    edits: [{ tool: 'edit', path: 'src/auth/logout.ts' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
    },
  },
  {
    id: 'fix-03-typo-copy',
    kind: 'fix',
    intent: '修正设置页文案拼写错误',
    toolsBeforeFirstEdit: [{ tool: 'read', path: 'src/settings/copy.ts' }],
    edits: [{ tool: 'edit', path: 'src/settings/copy.ts' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
    },
  },
  {
    id: 'fix-04-null-guard',
    kind: 'fix',
    intent: '为 profile loader 增加 null 守卫',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'src/profile/load.ts' },
      { tool: 'read', path: 'src/profile/load.test.ts' },
      { tool: 'bash', command: 'pnpm test src/profile/load.test.ts' },
    ],
    edits: [
      { tool: 'edit', path: 'src/profile/load.ts' },
      { tool: 'edit', path: 'src/profile/load.test.ts' },
    ],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
    },
  },
  {
    id: 'fix-05-date-format',
    kind: 'fix',
    intent: '修复列表日期时区显示偏移',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'src/ui/formatDate.ts' },
      { tool: 'read', path: 'src/ui/formatDate.test.ts' },
    ],
    edits: [{ tool: 'edit', path: 'src/ui/formatDate.ts' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
    },
  },
  // --- 3 ordinary features ---
  {
    id: 'feat-01-filter-chip',
    kind: 'feature',
    intent: '在订单列表增加状态筛选 chip',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'src/orders/List.tsx' },
      { tool: 'read', path: 'src/orders/api.ts' },
      { tool: 'bash', command: 'rg -n FilterChip src' },
    ],
    edits: [
      { tool: 'edit', path: 'src/orders/List.tsx' },
      { tool: 'write', path: 'src/orders/StatusFilter.tsx' },
    ],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
    },
  },
  {
    id: 'feat-02-empty-state',
    kind: 'feature',
    intent: '为空搜索结果增加 empty state 组件',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'src/search/Results.tsx' },
      { tool: 'read', path: 'src/ui/Empty.tsx' },
    ],
    edits: [
      { tool: 'edit', path: 'src/search/Results.tsx' },
      { tool: 'write', path: 'src/search/EmptyResults.tsx' },
    ],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
    },
  },
  {
    id: 'feat-03-retry-button',
    kind: 'feature',
    intent: '网络错误提示增加重试按钮',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'src/ui/ErrorBanner.tsx' },
      { tool: 'read', path: 'src/ui/ErrorBanner.test.tsx' },
      { tool: 'bash', command: 'pnpm test src/ui/ErrorBanner.test.tsx' },
      { tool: 'read', path: 'src/hooks/useRetry.ts' },
    ],
    edits: [
      { tool: 'edit', path: 'src/ui/ErrorBanner.tsx' },
      { tool: 'edit', path: 'src/ui/ErrorBanner.test.tsx' },
    ],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
    },
  },
  // --- 2 deterministic risk triggers ---
  {
    id: 'risk-01-migration',
    kind: 'risk',
    intent: '为 users.email 增加唯一索引迁移',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'migrations/001_init.sql' },
      { tool: 'bash', command: 'ls migrations' },
    ],
    edits: [
      {
        tool: 'write',
        path: 'migrations/002_users_email_unique.sql',
        content: 'CREATE UNIQUE INDEX CONCURRENTLY users_email_uidx ON users(email);',
      },
    ],
    expect: {
      riskAfterEdits: 'guarded',
      gateTrigger: 'databaseMigration',
      artifactCount: 0,
      openGate: true,
    },
  },
  {
    id: 'risk-02-dependency',
    kind: 'risk',
    intent: '升级 zod 并调整 package.json',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'package.json' },
      { tool: 'bash', command: 'pnpm why zod' },
    ],
    edits: [{ tool: 'edit', path: 'package.json' }],
    expect: {
      riskAfterEdits: 'guarded',
      gateTrigger: 'dependencyChange',
      artifactCount: 0,
      openGate: true,
    },
  },
];
