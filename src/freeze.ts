/**
 * Provider 输入隔离：深拷贝后 freeze，防止第三方修改宿主对象。
 */

const configCache = new WeakMap<object, object>();

/**
 * 深拷贝并递归 Object.freeze。
 * @param value 任意 JSON 兼容值
 * @returns 冻结副本
 */
export function deepFreezeCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

/**
 * 递归冻结对象（原地）。
 * @param value 值
 * @returns 冻结后的同一引用
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value as object)) {
    const child = (value as Record<PropertyKey, unknown>)[key];
    if (child && typeof child === 'object') {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

/**
 * 按 config 对象身份缓存冻结视图（避免每次 tool_call 深拷贝）。
 * @param config 宿主配置对象
 * @returns 冻结只读副本
 */
export function frozenConfigView<T extends object>(config: T): T {
  const cached = configCache.get(config);
  if (cached) return cached as T;
  const frozen = deepFreezeCopy(config);
  configCache.set(config, frozen as object);
  return frozen;
}

/**
 * 测试辅助：清空 config 冻结缓存。
 */
export function clearFrozenConfigCache(): void {
  // WeakMap 无 clear；用新 Map 替换不可行（模块级常量）。
  // 测试通过换新 config 对象绕过；此函数保留为 API 占位。
}
