/**
 * 预置链配置。
 *
 * chain-a   : v1 上下文，初始活动链（宽松校验 + 移除 ssn）
 * chain-a2  : v1 上下文，同插件序列、收紧规则 —— 用于"逐插件替换"滚动演示
 * chain-b   : v2 上下文，结构升级（加 scope 规则、移除更多字段）—— 必须走原子热切换
 * chain-c   : v2 上下文但含 v1-only 的 legacy-audit —— confirm 时被兼容性闸门拦截
 */
export const seedChains = [
  {
    id: 'chain-a',
    rev: 1,
    contextVersion: 1,
    confirmed: true,
    description: '初始链 v1：宽松校验 + 移除 SSN',
    plugins: [
      {
        plugin: 'local-validation',
        config: {
          required: ['user.name'],
          rules: [
            { field: 'user.age', type: 'number', min: 0, max: 120 },
            { field: 'user.role', reject: ['banned'] },
          ],
        },
      },
      { plugin: 'field-removal', config: { remove: ['user.ssn'] } },
      { plugin: 'protocol-transform', config: { mode: 'envelope' } },
    ],
  },
  {
    id: 'chain-a2',
    rev: 1,
    contextVersion: 1,
    confirmed: true,
    description: '滚动目标 v1：同序列、收紧年龄下限到 18、多删 internal.debug',
    plugins: [
      {
        plugin: 'local-validation',
        config: {
          required: ['user.name', 'user.age'],
          rules: [
            { field: 'user.age', type: 'number', min: 18, max: 120 },
            { field: 'user.role', reject: ['banned', 'guest'] },
          ],
        },
      },
      { plugin: 'field-removal', config: { remove: ['user.ssn', 'internal.debug'] } },
      { plugin: 'protocol-transform', config: { mode: 'envelope' } },
    ],
  },
  {
    id: 'chain-b',
    rev: 1,
    contextVersion: 2,
    confirmed: true,
    description: '原子热切换目标 v2：scope 校验 + 更彻底的字段移除',
    plugins: [
      {
        plugin: 'local-validation',
        config: {
          required: ['user.name', 'user.age'],
          rules: [
            { field: 'user.age', type: 'number', min: 18, max: 120 },
            { field: 'user.role', enum: ['member', 'admin'] },
            { field: 'user.role', scopeRequired: 'write:users' },
          ],
        },
      },
      {
        plugin: 'field-removal',
        config: { remove: ['user.ssn', 'internal.debug', 'internal.token'] },
      },
      { plugin: 'protocol-transform', config: { mode: 'envelope' } },
    ],
  },
  {
    id: 'chain-c',
    rev: 1,
    contextVersion: 2,
    confirmed: false,
    description: '故意不兼容：v2 链里放了 v1-only 的 legacy-audit，confirm 必须被拦',
    plugins: [
      {
        plugin: 'local-validation',
        config: { required: ['user.name'] },
      },
      { plugin: 'legacy-audit', config: { tag: 'old-auditor' } },
      { plugin: 'field-removal', config: { remove: ['user.ssn'] } },
    ],
  },
];
