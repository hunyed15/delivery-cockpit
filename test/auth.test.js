/**
 * 显式路径的写授权（fail-closed）。
 *
 * 这条闸门挡的是"模型可控的 cwd 把状态写到任意目录"：工具参数来自模型，
 * 而 HTTP 层的同源写接口只能打到已登记工作区。两者必须同一口径 ——
 * 无法确认归属时**拒绝**，不是放行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createAuthorizeWrite } from '../index.js'

const ROOT = resolve('D:/Coding/demo-project')
const INSIDE = resolve(ROOT, 'packages', 'web')
const OUTSIDE = resolve('D:/somewhere-else')

const workspaceOf = (path) => ({ id: 'w1', title: 'demo', path })

test('已登记工作区本身：放行', async () => {
  const authorize = createAuthorizeWrite({
    resolveWorkspace: async (path) => (path === ROOT ? workspaceOf(ROOT) : null),
    listWorkspaces: async () => [workspaceOf(ROOT)],
  })
  assert.equal(await authorize(ROOT), ROOT)
})

test('已登记工作区的子目录：放行（子目录也是同一个项目）', async () => {
  const authorize = createAuthorizeWrite({
    resolveWorkspace: async () => null,
    listWorkspaces: async () => [workspaceOf(ROOT)],
  })
  assert.equal(await authorize(INSIDE), INSIDE)
})

test('不在任何已登记工作区内：拒绝', async () => {
  const authorize = createAuthorizeWrite({
    resolveWorkspace: async () => null,
    listWorkspaces: async () => [workspaceOf(ROOT)],
  })
  await assert.rejects(() => authorize(OUTSIDE), /拒绝写盘/)
})

test('一条已登记工作区都没有：拒绝（空 ≠ 免检）', async () => {
  const authorize = createAuthorizeWrite({
    resolveWorkspace: async () => null,
    listWorkspaces: async () => [],
  })
  await assert.rejects(() => authorize(ROOT), /还没有任何已登记工作区/)
})

test('工作区列表读不到（抛错 / 不是数组）：拒绝', async () => {
  const throwing = createAuthorizeWrite({
    resolveWorkspace: async () => null,
    listWorkspaces: async () => {
      throw new Error('boom')
    },
  })
  await assert.rejects(() => throwing(ROOT), /拒绝写盘/)

  const malformed = createAuthorizeWrite({
    resolveWorkspace: async () => null,
    listWorkspaces: async () => null,
  })
  await assert.rejects(() => malformed(ROOT), /无法读取已登记工作区列表/)
})

test('工作区服务整体不可用：拒绝（fail-closed），只有会话工作目录那条路仍可用', async () => {
  const authorize = createAuthorizeWrite({
    resolveWorkspace: async () => null,
    listWorkspaces: async () => [],
  })
  await assert.rejects(() => authorize(OUTSIDE), /拒绝写盘/)
})

test('resolveByPath 抛错但 list 里有匹配：仍能放行（两种解析互为兜底）', async () => {
  const authorize = createAuthorizeWrite({
    resolveWorkspace: async () => {
      throw new Error('resolveByPath 不支持这个路径')
    },
    listWorkspaces: async () => [workspaceOf(ROOT)],
  })
  assert.equal(await authorize(INSIDE), INSIDE)
})

test('resolveByPath 返回的工作区必须真的包含目标路径（两分支同语义）', async () => {
  const SIBLING = resolve('D:/Coding/another-project')
  // 解析服务"认"了这个路径，但返回的是别的工作区：不能因此放行。
  const denyCase = createAuthorizeWrite({
    resolveWorkspace: async () => workspaceOf(SIBLING),
    listWorkspaces: async () => [workspaceOf(ROOT)],
  })
  await assert.rejects(() => denyCase(OUTSIDE), /拒绝写盘/)

  // 目标本身在 list 里已登记：解析服务的结论没被采信，但 list 分支给出了合法归属。
  const allowCase = createAuthorizeWrite({
    resolveWorkspace: async () => workspaceOf(SIBLING),
    listWorkspaces: async () => [workspaceOf(ROOT)],
  })
  assert.equal(await allowCase(ROOT), ROOT)
})

test('返回的是 resolve 后的路径（不让相对路径混进写操作）', async () => {
  const cwd = resolve('.')
  const authorize = createAuthorizeWrite({
    // resolveByPath 是权威解析：它认了这个路径（含相对路径），且返回的工作区确实覆盖它。
    resolveWorkspace: async () => workspaceOf(cwd),
    listWorkspaces: async () => [workspaceOf(ROOT)],
  })
  assert.equal(await authorize('.'), cwd)
})
