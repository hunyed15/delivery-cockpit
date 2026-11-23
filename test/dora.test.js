/**
 * 线上 DORA 数据：读 dora.json + 指标替换代理口径。
 * 这里只测纯读/纯算，不依赖真实 CI。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readDoraData } from '../lib/dora.js'
import { computeMetrics } from '../lib/metrics.js'

const NOW = new Date('2026-11-23T12:00:00.000Z')
const iso = (minusHours) => new Date(NOW.getTime() - minusHours * 3600_000).toISOString()

async function withProject(run) {
  const project = await mkdtemp(join(tmpdir(), 'dc-dora-'))
  try {
    await run(project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

test('dora.json 缺失：available=false、error=null，不报错也不降级', async () => {
  await withProject(async (project) => {
    const dora = await readDoraData(project)
    assert.equal(dora.available, false)
    assert.equal(dora.error, null)
    assert.deepEqual(dora.deployments, [])
  })
})

test('dora.json：合法行归一、坏行计数；坏 JSON 返回 bad-json', async () => {
  await withProject(async (project) => {
    await mkdir(join(project, '.dsh', 'plugin-state'), { recursive: true })
    await writeFile(
      join(project, '.dsh', 'plugin-state', 'dora.json'),
      JSON.stringify({
        deployments: [
          { at: iso(1), version: 'v1.0.1', success: true, leadTimeHours: 12 },
          { at: 'not-a-date', success: true },
          { at: iso(72), success: false },
        ],
        incidents: [
          { at: iso(5), resolvedAt: iso(3) },
          { at: iso(5), resolvedAt: iso(6) },
        ],
      }),
      'utf8',
    )
    const dora = await readDoraData(project)
    assert.equal(dora.available, true)
    assert.equal(dora.deployments.length, 2)
    assert.equal(dora.incidents.length, 1)
    assert.equal(dora.invalid, 2)

    await writeFile(join(project, '.dsh', 'plugin-state', 'dora.json'), '{ bad', 'utf8')
    const broken = await readDoraData(project)
    assert.equal(broken.available, false)
    assert.equal(broken.error, 'bad-json')
  })
})

test('computeMetrics：有线上数据时替换发布/失败率/交付周期并给出 MTTR', () => {
  const dora = {
    available: true,
    deployments: [
      { at: NOW.getTime() - 3600_000, success: true, leadTimeHours: 10 },
      { at: NOW.getTime() - 2 * 3600_000, success: false, leadTimeHours: 20 },
      { at: NOW.getTime() - 10 * 24 * 3600_000, success: true, leadTimeHours: 30 },
    ],
    incidents: [
      { at: NOW.getTime() - 5 * 3600_000, resolvedAt: NOW.getTime() - 3 * 3600_000 },
      { at: NOW.getTime() - 9 * 3600_000, resolvedAt: NOW.getTime() - 8 * 3600_000 },
    ],
    invalid: 0,
  }
  const result = computeMetrics({ now: NOW, windowDays: 30, dora })
  assert.equal(result.source, 'live')
  assert.equal(result.metrics.deploymentFrequency7d.value, 2)
  assert.equal(result.metrics.deploymentFrequency7d.source, 'dora')
  assert.equal(result.metrics.changeFailureRate.value, 0.3333)
  assert.equal(result.metrics.changeFailureRate.sample, 3)
  assert.equal(result.metrics.leadTimeHours.value, 20)
  assert.equal(result.metrics.leadTimeHours.source, 'dora')
  assert.equal(result.metrics.mttrHours.value, 1.5)
  assert.equal(result.dora.deployments, 3)
})

test('computeMetrics：没有线上数据时 mttrHours 为 null 并说明未接线上数据', () => {
  const result = computeMetrics({ now: NOW })
  assert.equal(result.source, 'proxy')
  assert.equal(result.metrics.mttrHours.value, null)
  assert.ok(result.unavailable.some((item) => item.metric === 'mttrHours' && /未接线上事故数据/.test(item.reason)))
})

test('dora 可用但窗口内零部署：变更失败率是 null（—），不是 0%', () => {
  const dora = { available: true, deployments: [], incidents: [], invalid: 0 }
  const result = computeMetrics({ now: NOW, windowDays: 30, dora })
  assert.equal(result.source, 'live')
  assert.equal(result.metrics.changeFailureRate.value, null)
  assert.equal(result.metrics.deploymentFrequency7d.value, 0)
  assert.equal(result.metrics.deploymentFrequency7d.sample, 0)
  assert.ok(result.unavailable.some((item) => item.metric === 'changeFailureRate' && /没有线上发布记录/.test(item.reason)))
})