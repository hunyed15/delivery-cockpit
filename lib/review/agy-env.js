/**
 * agy 子进程代理环境：只给 agy 注入，绝不改 Host 全局环境。
 * proxy 为空表示不额外注入（继承调用方已有环境）；非空时同时设置大小写变量。
 */
export function buildAgyProxyEnv(proxy, baseEnv = {}) {
  const env = { ...baseEnv }
  const value = typeof proxy === 'string' ? proxy.trim() : ''
  if (value === '') return env
  env.HTTP_PROXY = value
  env.HTTPS_PROXY = value
  env.ALL_PROXY = value
  env.http_proxy = value
  env.https_proxy = value
  env.all_proxy = value
  const existing = String(env.NO_PROXY ?? env.no_proxy ?? '')
  const parts = new Set(existing.split(',').map((item) => item.trim()).filter(Boolean))
  for (const item of ['127.0.0.1', 'localhost', '::1']) parts.add(item)
  env.NO_PROXY = [...parts].join(',')
  env.no_proxy = env.NO_PROXY
  return env
}
