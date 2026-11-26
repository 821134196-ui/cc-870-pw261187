import { createFieldRemoval } from './field-removal.js';
import { createProtocolTransform } from './protocol-transform.js';
import { createLocalValidation } from './local-validation.js';
import { createLegacyAudit } from './legacy-audit.js';

/** 插件注册表：name -> 工厂函数(config) => 插件实例 */
export const pluginRegistry = {
  'field-removal': createFieldRemoval,
  'protocol-transform': createProtocolTransform,
  'local-validation': createLocalValidation,
  'legacy-audit': createLegacyAudit,
};

export function listPluginSpecs() {
  // 用标准配置实例化一份用于展示元数据
  const samples = {
    'field-removal': { remove: ['user.ssn'] },
    'protocol-transform': { mode: 'envelope' },
    'local-validation': { required: ['user.name'] },
    'legacy-audit': { tag: 'demo' },
  };
  return Object.entries(pluginRegistry).map(([id, factory]) => {
    const instance = factory(samples[id]);
    return {
      id,
      kind: instance.kind,
      supportedContextVersions: instance.supportedContextVersions,
      sampleConfig: samples[id],
    };
  });
}
