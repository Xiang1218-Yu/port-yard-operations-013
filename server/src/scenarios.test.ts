import test from 'node:test'; import assert from 'node:assert/strict';
import { containers as prodContainers, equipment as prodEquipment, tasks as prodTasks, updateYardTask, voyages as prodVoyages, blocks as prodBlocks } from './domain.js';
import { _configureScenarioTtl, bumpProductionRevision, cancelScenarioCompute, commitScenario, createScenario, getScenario, rebaseScenario, startScenarioCompute, awaitScenarioCompute, type Scenario } from './scenarios.js';

const compute = async (id: string) => { startScenarioCompute(id); await awaitScenarioCompute(id); return getScenario(id); };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const conflictCodes = (error: unknown) => { const e = error as { code: string; report?: { conflicts: { code: string }[] } }; return { code: e.code, codes: (e.report?.conflicts ?? []).map(c => c.code) }; };

test('推演在隔离副本上计算，生产数组在提交前完全不被修改', async () => {
  const etd = new Date(Date.now() + 20 * 3600000).toISOString();
  const scenario = createScenario({
    name: '提前装船 + 近区块移箱', voyageId: 'VOY-QF2',
    adjustments: {
      etd,
      earlyLoadContainerIds: ['FCIU-9920310'],
      relocations: [{ containerId: 'MSCU-4829017', targetBlockId: 'C03' }],
      equipmentOverrides: [{ equipmentId: 'QC-07', movesPerHour: 40 }],
      blockCapacityOverrides: [{ blockId: 'C03', capacityDelta: 12 }]
    }
  });
  const result = await compute(scenario.id);
  assert.equal(result.status, 'computed');
  assert.ok(result.result);
  assert.equal(result.result.remainingMoves.production, 760);
  assert.equal(result.result.remainingMoves.projected, 759);
  assert.equal(result.result.stats.earlyLoads, 1);
  assert.equal(result.result.stats.relocations, 1);
  assert.ok(result.result.assumptions.some(a => a.id === 'window'));
  assert.ok(result.result.assumptions.some(a => a.id === 'early-load'));
  assert.ok(result.result.assumptions.some(a => a.id === 'relocation'));
  assert.ok(result.result.affectedTasks.length >= 2);
  assert.ok(result.result.risks.some(r => r.code === 'QUAY_CAPACITY_GAP' && r.basis === 'assumption'));
  assert.ok(result.result.metrics.some(m => m.key === 'remaining' && m.basis === 'assumption'));
  assert.equal(result.result.blockImpacts.find(b => b.blockId === 'C03')?.basis, 'assumption');
  /* 生产事实结论与假设结论必须可区分 */
  assert.ok(result.result.risks.some(r => r.basis === 'production-fact'));
  /* 生产数据零污染 */
  assert.equal(prodEquipment.find(e => e.id === 'QC-07')?.movesPerHour, 31);
  assert.equal(prodBlocks.find(b => b.id === 'C03')?.capacity, 192);
  assert.notEqual(prodVoyages.find(v => v.id === 'VOY-QF2')?.etd, etd);
  assert.equal(prodContainers.find(c => c.id === 'MSCU-4829017')?.yardSlot, 'A01-R07-T3');
  assert.equal(prodTasks.find(t => t.id === 'TASK-104')?.scheduledAt, prodTasks.find(t => t.id === 'TASK-104')?.scheduledAt);
});

test('容量不足：目标区块在假设占用下满载时移箱被否决并给出高风险', async () => {
  const scenario = createScenario({
    name: 'D05 收窄到当前占用', voyageId: 'VOY-AX7',
    adjustments: { relocations: [{ containerId: 'MSCU-4829017', targetBlockId: 'D05' }], blockCapacityOverrides: [{ blockId: 'D05', capacityDelta: -25 }] }
  });
  const result = await compute(scenario.id);
  assert.equal(result.result!.stats.rejectedRelocations, 1);
  assert.ok(result.result!.risks.some(r => r.code === 'CAPACITY_SHORTFALL'));
  assert.equal(result.result!.blockImpacts.find(b => b.blockId === 'D05')?.feasible, false);
});

test('计算中断：取消后保留中断状态，结果不完整且禁止提交', async () => {
  const scenario = createScenario({
    name: '长计算推演', voyageId: 'VOY-QF2',
    adjustments: { earlyLoadContainerIds: ['FCIU-9920310'] }
  });
  startScenarioCompute(scenario.id, { stepDelayMs: 25 });
  await sleep(40);
  cancelScenarioCompute(scenario.id);
  let current = getScenario(scenario.id);
  for (let i = 0; i < 40 && current.status !== 'interrupted'; i += 1) { await sleep(25); current = getScenario(scenario.id); }
  assert.equal(current.status, 'interrupted');
  assert.equal(current.result?.status, 'interrupted');
  assert.ok(current.result?.interruptedAt);
  await assert.rejects(commitScenario(scenario.id), error => conflictCodes(error).code === 'COMPUTE_INTERRUPTED');
});

test('方案过期：超过 TTL 后提交返回 410，需要重建基线', async () => {
  _configureScenarioTtl(20);
  const scenario = createScenario({ name: '短命方案', voyageId: 'VOY-QF2', adjustments: { earlyLoadContainerIds: ['FCIU-9920310'] } });
  await sleep(45);
  assert.equal(getScenario(scenario.id).status, 'expired');
  await assert.rejects(commitScenario(scenario.id), error => conflictCodes(error).code === 'SCENARIO_EXPIRED');
  _configureScenarioTtl(30 * 60 * 1000);
});

test('版本冲突：推演期间生产改动相交实体导致提交失败，rebase 后可提交', async () => {
  const eta = new Date(Date.now() + 130 * 60000).toISOString();
  const etd = new Date(Date.now() + 700 * 60000).toISOString();
  const scenario = createScenario({ name: '提前 FCIU', voyageId: 'VOY-QF2', adjustments: { eta, etd, earlyLoadContainerIds: ['FCIU-9920310'] } });
  await compute(scenario.id);
  /* 模拟推演期间生产发生变更：调度员在生产中改了 TASK-104 优先级 */
  updateYardTask('TASK-104', { priority: 42 });
  bumpProductionRevision();
  const error = await commitScenario(scenario.id).then(() => null).catch(reason => reason);
  assert.equal(conflictCodes(error).code, 'COMMIT_CONFLICT');
  assert.ok(conflictCodes(error).codes.includes('CONFLICT_PRODUCTION_CHANGED'));
  /* 与方案不相交的箱变更后，rebase 并重新推演即可提交 */
  const rebased = rebaseScenario(scenario.id);
  assert.notEqual(rebased.baseRevision, scenario.baseRevision || 0);
  await compute(scenario.id);
  const receipt = await commitScenario(scenario.id);
  assert.equal(receipt.applied.earlyLoads[0].containerId, 'FCIU-9920310');
  assert.equal(prodVoyages.find(v => v.id === 'VOY-QF2')?.eta, eta);
  assert.equal(prodTasks.find(t => t.id === 'TASK-104')?.scheduledAt, eta);
});

test('两个方案同时提交：后提交方案检测到实体重叠冲突', async () => {
  const first = createScenario({ name: '方案A 移 MSCU', voyageId: 'VOY-AX7', adjustments: { relocations: [{ containerId: 'MSCU-4829017', targetBlockId: 'C03' }] } });
  const second = createScenario({ name: '方案B 也移 MSCU', voyageId: 'VOY-AX7', adjustments: { relocations: [{ containerId: 'MSCU-4829017', targetBlockId: 'C03' }] } });
  await compute(first.id);
  await compute(second.id);
  await commitScenario(first.id);
  const error = await commitScenario(second.id).then(() => null).catch(reason => reason);
  assert.equal(conflictCodes(error).code, 'COMMIT_CONFLICT');
  assert.ok(conflictCodes(error).codes.includes('CONFLICT_SCENARIO_OVERLAP'));
  assert.equal(prodContainers.find(c => c.id === 'MSCU-4829017')?.yardSlot.startsWith('C03-'), true);
});

test('箱子已完成任务：推演期间生产把装船任务做完，提交被拒', async () => {
  const scenario = createScenario({
    name: '目标已完成', voyageId: 'VOY-QF2',
    adjustments: { eta: new Date(Date.now() + 60 * 60000).toISOString(), etd: new Date(Date.now() + 500 * 60000).toISOString(), earlyLoadContainerIds: ['FCIU-9920310'] }
  });
  await compute(scenario.id);
  updateYardTask('TASK-104', { status: 'done' });
  bumpProductionRevision();
  const error = await commitScenario(scenario.id).then(() => null).catch(reason => reason);
  assert.ok(conflictCodes(error).codes.includes('CONFLICT_ALREADY_COMPLETED'));
});

test('正常提交：窗口、装船任务差异写入生产，审计与版本号更新', async () => {
  const etd = new Date(Date.now() + 900 * 60000).toISOString();
  const scenario = createScenario({
    name: 'AX7 窗口缩短方案', voyageId: 'VOY-AX7',
    adjustments: { etd, equipmentOverrides: [{ equipmentId: 'QC-07', movesPerHourDelta: 4 }], blockCapacityOverrides: [{ blockId: 'D05', capacityDelta: 8 }] }
  });
  const result = await compute(scenario.id);
  assert.equal(result.result!.diff.equipmentOverrides[0].patch.movesPerHour, 35);
  const receipt = await commitScenario(scenario.id);
  assert.equal(receipt.applied.blockCapacityOverrides[0].patch.capacity, 104);
  assert.equal(prodVoyages.find(v => v.id === 'VOY-AX7')?.etd, etd);
  assert.equal(prodEquipment.find(e => e.id === 'QC-07')?.movesPerHour, 35);
  assert.equal(prodBlocks.find(b => b.id === 'D05')?.capacity, 104);
  assert.equal(getScenario(scenario.id).status, 'committed');
});
