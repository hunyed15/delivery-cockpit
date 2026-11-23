/**
 * 团队泳道读取：用假 ctx 覆盖"正常 / cwd 过滤 / 服务缺失 / 名字回退 / 截断 / 读失败"。
 * 这个模块的硬约束是**绝不抛**：右栏少一条信息不能把详情页打挂。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { readTeam } from '../lib/team.js'

const PROJECT = 'D:\\work\\shop'

function fakeCtx({ agentIds, headers, namesOf, throwGet = [], listThrows = [] } = {}) {
  const services = {
    agents:
      agentIds === undefined
        ? undefined
        : {
            list: async () => {
              if (listThrows.includes('agents')) throw new Error('agents 读不到')
              return agentIds.map((id) => ({ id }))
            },
          },
    sessions:
      headers === undefined
        ? undefined
        : {
            list: async () => {
              if (listThrows.includes('sessions')) throw new Error('sessions 读不到')
              return headers.map((header) => ({ id: header.id, header }))
            },
          },
    subagents: namesOf === undefined ? undefined : { namesOf },
  }
  return {
    get(name) {
      if (throwGet.includes(name)) throw new Error(`${name} 服务不可用`)
      return services[name]
    },
  }
}

const header = (patch) => ({
  id: 's1',
  cwd: PROJECT,
  parentSession: null,
  delegationDepth: 0,
  agentPreset: null,
  origin: null,
  createdAt: '2026-11-20T10:00:00.000Z',
  ...patch,
})

test('正常：root + child，名字来自 namesOf，在线状态来自 agents 列表', async () => {
  const ctx = fakeCtx({
    agentIds: ['s1', 's2'],
    headers: [
      header({ id: 's1', origin: 'root' }),
      header({
        id: 's2',
        parentSession: 's1',
        delegationDepth: 1,
        agentPreset: 'review',
        origin: 'subagent',
        createdAt: '2026-11-20T10:01:00.000Z',
      }),
    ],
    namesOf: async (agent) => (agent.id === 's1' ? { self: 'lead' } : { self: 'reviewer/checker', parent: 'lead' }),
  })

  const team = await readTeam(ctx, PROJECT)
  assert.equal(team.available, true)
  assert.equal(team.reason, null)
  assert.equal(team.truncated, false)
  assert.deepEqual(team.agents, [
    {
      id: 's1',
      name: 'lead',
      parentName: null,
      depth: 0,
      preset: null,
      origin: 'root',
      createdAt: '2026-11-20T10:00:00.000Z',
      running: true,
    },
    {
      id: 's2',
      name: 'reviewer/checker',
      parentName: 'lead',
      depth: 1,
      preset: 'review',
      origin: 'subagent',
      createdAt: '2026-11-20T10:01:00.000Z',
      running: true,
    },
  ])
})

test('只列这个项目的会话：别的 cwd 过滤掉（Windows 大小写不敏感）', async () => {
  const ctx = fakeCtx({
    agentIds: ['s1', 's9'],
    headers: [
      header({ id: 's1' }),
      header({ id: 's9', cwd: 'D:\\work\\other' }),
      // 会话没有 cwd：无法证明属于本项目，跳过（不猜）。
      { id: 's8' },
    ],
    namesOf: async () => null,
  })
  const team = await readTeam(ctx, PROJECT)
  assert.equal(team.available, true)
  assert.deepEqual(team.agents.map((agent) => agent.id), ['s1'])

  if (process.platform === 'win32') {
    const upper = fakeCtx({
      agentIds: ['s1'],
      headers: [header({ id: 's1', cwd: 'D:\\WORK\\Shop' })],
      namesOf: async () => null,
    })
    const same = await readTeam(upper, PROJECT)
    assert.deepEqual(same.agents.map((agent) => agent.id), ['s1'], '同一目录的大小写差异不能判成两个项目')
  }
})

test('服务缺失：agents / sessions / subagents 任一不暴露 ⇒ service-missing，不抛', async () => {
  for (const ctx of [
    fakeCtx({ headers: [header({})] }),
    fakeCtx({ agentIds: ['s1'] }),
    fakeCtx({ agentIds: ['s1'], headers: [header({})], throwGet: ['agents'] }),
    fakeCtx({ agentIds: ['s1'], headers: [header({})], throwGet: ['sessions'] }),
    null,
    {},
  ]) {
    const team = await readTeam(ctx, PROJECT)
    assert.deepEqual(team, { available: false, reason: 'service-missing', agents: [] })
  }
})

test('服务读失败：list 抛错 ⇒ read-error，不把异常抛给详情页', async () => {
  const team = await readTeam(
    fakeCtx({ agentIds: ['s1'], headers: [header({})], listThrows: ['agents'] }),
    PROJECT,
  )
  assert.deepEqual(team, { available: false, reason: 'read-error', agents: [] })
})

test('namesOf 抛错 / 返回空时回退：无 parent 叫 lead，有 parent 叫 subagent-<id 后 6 位>', async () => {
  const ctx = fakeCtx({
    agentIds: ['root-session-000001'],
    headers: [
      header({ id: 'root-session-000001' }),
      header({ id: 'child-session-000002', parentSession: 'root-session-000001', delegationDepth: 1 }),
    ],
    namesOf: async () => {
      throw new Error('namesOf 不可用')
    },
  })
  const team = await readTeam(ctx, PROJECT)
  assert.equal(team.available, true)
  const [root, child] = team.agents
  assert.equal(root.name, 'lead')
  assert.equal(root.parentName, null)
  assert.equal(child.name, 'subagent-000002')
  // namesOf 不可用时，父名用父行名字兜底（不是 null）。
  assert.equal(child.parentName, 'lead')

  // namesOf 返回空 self：同样走回退，不出现空名字。
  const empty = await readTeam(
    fakeCtx({
      agentIds: ['s1'],
      headers: [header({ id: 's1' })],
      namesOf: async () => ({ self: '' }),
    }),
    PROJECT,
  )
  assert.equal(empty.agents[0].name, 'lead')
})

test('排序：depth 升序 + createdAt 升序；缺 createdAt 排最后', async () => {
  const ctx = fakeCtx({
    agentIds: ['a', 'b', 'c', 'd'],
    headers: [
      header({ id: 'd', delegationDepth: 2, createdAt: '2026-11-20T10:00:00.000Z' }),
      header({ id: 'b', delegationDepth: 0, createdAt: '2026-11-20T10:02:00.000Z' }),
      header({ id: 'c', delegationDepth: 1, createdAt: null }),
      header({ id: 'a', delegationDepth: 0, createdAt: '2026-11-20T10:01:00.000Z' }),
    ],
    namesOf: async () => null,
  })
  const team = await readTeam(ctx, PROJECT)
  assert.deepEqual(team.agents.map((agent) => agent.id), ['a', 'b', 'c', 'd'])
  assert.equal(team.agents[2].createdAt, null)
})

test('截断：超过 20 行只保留前 20 行并标记 truncated', async () => {
  const headers = Array.from({ length: 25 }, (_, index) =>
    header({
      id: `s${String(index + 1).padStart(2, '0')}`,
      createdAt: `2026-11-20T10:${String(index).padStart(2, '0')}:00.000Z`,
    }),
  )
  const ctx = fakeCtx({
    agentIds: headers.map((item) => item.id),
    headers,
    namesOf: async () => null,
  })
  const team = await readTeam(ctx, PROJECT)
  assert.equal(team.available, true)
  assert.equal(team.agents.length, 20)
  assert.equal(team.truncated, true)
  assert.equal(team.agents[0].id, 's01')
  assert.equal(team.agents[19].id, 's20')
})

test('非在线会话照样显示（running=false），不因离线就隐藏', async () => {
  const ctx = fakeCtx({
    agentIds: ['s1'],
    headers: [header({ id: 's1' }), header({ id: 's2', parentSession: 's1', delegationDepth: 1 })],
    namesOf: async () => null,
  })
  const team = await readTeam(ctx, PROJECT)
  assert.equal(team.agents.length, 2)
  assert.equal(team.agents[0].running, true)
  assert.equal(team.agents[1].running, false)
})

test('子目录里的会话也算这个项目（worktree 仍是独立路径）', async () => {
  const ctx = fakeCtx({
    agentIds: ['s2'],
    headers: [header({ id: 's2', cwd: PROJECT + '\\\\web' })],
  })
  const team = await readTeam(ctx, PROJECT)
  assert.equal(team.available, true)
  assert.equal(team.agents.length, 1)
  assert.equal(team.agents[0].id, 's2')
})