import test from 'node:test'
import assert from 'node:assert/strict'

import { readMcpNames } from '../index.js'

const fakeCtx = (services = {}) => ({ get: (name) => services[name] })

test('readMcpNames：mcpManager 列表 + mcp__ 工具名反推，取并集（配置型 bundle 也能识别）', () => {
  const ctx = fakeCtx({
    mcpManager: { list: () => [{ name: 'github' }] },
    tools: {
      definitions: () => [
        { name: 'mcp__playwright__browser_navigate' },
        { name: 'mcp__context7__query-docs' },
        { name: 'mcp__playwright__browser_click' },
        { name: 'cockpit_report' },
      ],
    },
  })
  assert.deepEqual([...readMcpNames(ctx)].sort(), ['context7', 'github', 'playwright'])
})

test('readMcpNames：只有工具名也能识别；服务都不可用返回 null', () => {
  const onlyTools = fakeCtx({
    tools: { definitions: () => [{ name: 'mcp__exa__search' }] },
  })
  assert.deepEqual([...readMcpNames(onlyTools)], ['exa'])

  assert.equal(readMcpNames(fakeCtx()), null)
})

test('readMcpNames：manager 抛错时仍用工具名兜底；两个服务存在但没有 MCP 工具 → 空集合', () => {
  const managerThrows = fakeCtx({
    mcpManager: {
      list: () => {
        throw new Error('boom')
      },
    },
    tools: { definitions: () => [{ name: 'mcp__github__list_issues' }] },
  })
  assert.deepEqual([...readMcpNames(managerThrows)], ['github'])

  const none = fakeCtx({ mcpManager: { list: () => [] }, tools: { definitions: () => [{ name: 'x' }] } })
  assert.deepEqual([...readMcpNames(none)], [])
})

test('readMcpNames：manager 里 failed/disabled/closed 的 server 不算可用', () => {
  const ctx = fakeCtx({
    mcpManager: {
      list: () => [
        { name: 'connected', status: { state: 'connected' } },
        { name: 'failed', status: { state: 'failed' } },
        { name: 'disabled', status: { state: 'disabled' } },
        { name: 'closed', status: { state: 'closed' } },
        { name: 'reconnecting', status: { state: 'reconnecting' } },
      ],
    },
  })
  assert.deepEqual([...readMcpNames(ctx)].sort(), ['connected', 'reconnecting'])
})