/**
 * dogfood 场景：v0.1 基线 + v0.2 check/guidance + v0.3 record 回读。
 */

export type ScenarioKind =
  | 'fix'
  | 'feature'
  | 'risk'
  | 'check'
  | 'guidance'
  | 'record';

export type SimulatedTool = {
  tool: 'read' | 'write' | 'edit' | 'bash';
  path?: string;
  command?: string;
  content?: string;
  /** bash 是否失败（仅模拟 tool_result.isError） */
  isError?: boolean;
  /** bash 输出片段（写入 check evidence） */
  output?: string;
};

export type ExpectedCheck = {
  name: string;
  passed: boolean;
};

export type PreexistingRecord = {
  type: 'decision' | 'migration' | 'incident';
  title: string;
  body?: string;
};

export type Scenario = {
  id: string;
  kind: ScenarioKind;
  intent: string;
  /** guidance 密度覆盖（默认用 DEFAULT_CONFIG） */
  guidance?: 'compact' | 'standard';
  /** 场景开始前预置到临时 cwd 的 records */
  preexistingRecords?: PreexistingRecord[];
  /** /run 到首次 write|edit 之前的工具调用（含首次编辑本身之前的次数） */
  toolsBeforeFirstEdit: SimulatedTool[];
  /** 首次及后续写操作 */
  edits: SimulatedTool[];
  /** 编辑后的验证 bash（用于 command check 自动记账） */
  proveCommands?: SimulatedTool[];
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
    /** 期望自动记账的 command checks */
    commandChecks?: ExpectedCheck[];
    /** 非验证 bash 不得写入 checks */
    noCommandChecks?: boolean;
    /** inject 文本必须包含 */
    injectIncludes?: string[];
    /** inject 文本不得包含 */
    injectExcludes?: string[];
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
  // --- v0.2: command check 自动记账 ---
  {
    id: 'check-01-targeted-pass',
    kind: 'check',
    intent: '跑目标测试并自动记账 targeted-test',
    toolsBeforeFirstEdit: [{ tool: 'read', path: 'src/profile/load.ts' }],
    edits: [{ tool: 'edit', path: 'src/profile/load.ts' }],
    proveCommands: [
      {
        tool: 'bash',
        command: 'pnpm test src/profile/load.test.ts',
        output: 'PASS src/profile/load.test.ts',
      },
    ],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
      commandChecks: [{ name: 'targeted-test', passed: true }],
    },
  },
  {
    id: 'check-02-bare-fail',
    kind: 'check',
    intent: '裸跑 npm test 失败时记账 test=fail',
    toolsBeforeFirstEdit: [{ tool: 'read', path: 'src/ui/formatDate.ts' }],
    edits: [{ tool: 'edit', path: 'src/ui/formatDate.ts' }],
    proveCommands: [
      {
        tool: 'bash',
        command: 'npm test',
        isError: true,
        output: 'FAIL suite',
      },
    ],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
      commandChecks: [{ name: 'test', passed: false }],
    },
  },
  {
    id: 'check-03-non-verify-ignored',
    kind: 'check',
    intent: '非验证 bash 不得误记账',
    toolsBeforeFirstEdit: [
      { tool: 'read', path: 'src/orders/List.tsx' },
      { tool: 'bash', command: 'rg -n FilterChip src' },
      { tool: 'bash', command: 'ls src/orders' },
    ],
    edits: [{ tool: 'edit', path: 'src/orders/List.tsx' }],
    proveCommands: [{ tool: 'bash', command: 'git status' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
      noCommandChecks: true,
    },
  },
  // --- v0.2: guidance 密度 ---
  {
    id: 'guidance-01-compact',
    kind: 'guidance',
    guidance: 'compact',
    intent: 'compact 注入仅状态行',
    toolsBeforeFirstEdit: [{ tool: 'read', path: 'src/settings/copy.ts' }],
    edits: [{ tool: 'edit', path: 'src/settings/copy.ts' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
      injectIncludes: ['Intent:', 'Checks due:'],
      injectExcludes: ['Rules:', 'Next:'],
    },
  },
  {
    id: 'guidance-02-standard',
    kind: 'guidance',
    guidance: 'standard',
    intent: 'standard 注入含 Rules 与 Next',
    toolsBeforeFirstEdit: [{ tool: 'read', path: 'src/settings/copy.ts' }],
    edits: [{ tool: 'edit', path: 'src/settings/copy.ts' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
      injectIncludes: ['Rules:', 'Next:'],
    },
  },
  // --- v0.3: record 回读索引 ---
  {
    id: 'record-01-index-injected',
    kind: 'record',
    guidance: 'standard',
    intent: 'standard 注入含 records 索引',
    preexistingRecords: [
      {
        type: 'decision',
        title: 'Auth boundary clears session on logout',
      },
      {
        type: 'migration',
        title: 'Add index on users.email',
      },
    ],
    toolsBeforeFirstEdit: [{ tool: 'read', path: 'src/auth/logout.ts' }],
    edits: [{ tool: 'edit', path: 'src/auth/logout.ts' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
      injectIncludes: ['Records', 'DEC-001'],
    },
  },
  {
    id: 'record-02-empty-omitted',
    kind: 'record',
    guidance: 'standard',
    intent: '无 records 时索引段应省略',
    toolsBeforeFirstEdit: [{ tool: 'read', path: 'src/settings/copy.ts' }],
    edits: [{ tool: 'edit', path: 'src/settings/copy.ts' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
      injectExcludes: ['Records'],
    },
  },
  {
    id: 'record-03-compact-omitted',
    kind: 'record',
    guidance: 'compact',
    intent: 'compact 下索引段应省略',
    preexistingRecords: [
      {
        type: 'decision',
        title: 'Auth boundary clears session on logout',
      },
    ],
    toolsBeforeFirstEdit: [{ tool: 'read', path: 'src/settings/copy.ts' }],
    edits: [{ tool: 'edit', path: 'src/settings/copy.ts' }],
    expect: {
      riskAfterEdits: 'lean',
      artifactCount: 0,
      openGate: false,
      injectExcludes: ['Records'],
    },
  },
];
