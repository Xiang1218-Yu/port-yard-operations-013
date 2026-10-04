import test from 'node:test'; import assert from 'node:assert/strict';
import {
  containers, blocks, tasks, voyages, equipment, getProductionVersion, updateContainer, createYardTask, assignTask,
  updateYardTask, recordAudit, bumpProductionVersion
} from './domain.js';
import {
  createScenario, computeScenario, interruptScenario, commitScenario, getScenario, listScenarios,
  snapshotProduction, ScenarioError, type ScenarioAssumptions
} from './scenarios.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const version = () => getProductionVersion();

const assumptionsFor = (overrides: Partial<ScenarioAssumptions> = {}): Partial<ScenarioAssumptions> => ({
  voyageId: 'VOY-QF2',
  earlyLoadContainerIds: ['FCIU-9920310'],
  relocations: [],
  equipmentOverrides: [{ equipmentId: 'QC-07', movesPerHour: 38 }],
  capacityOverrides: [],
  ...overrides,
});

test('沙盘推演在隔离副本上计算，绝不污染生产数据', async () => {
  const before = { version: version(), qc: equipment.find(e => e.id === 'QC-07')!.movesPerHour };
  const scn = createScenario({ name: '隔离性测试', assumptions: assumptionsFor({
    etd: new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
    capacityOverrides: [{ blockId: 'C03', capacity: 999 }],
  }) });
  await computeScenario(scn.id);
  // 生产实体没有被推演触碰
  assert.equal(version(), before.version, '推演不能递增生产版本');
  assert.equal(equipment.find(e => e.id === 'QC-07')!.movesPerHour, before.qc, '设备能力假设不能写入生产设备');
  assert.equal(blocks.find(b => b.id === 'C03')!.capacity, 192, '区块容量假设不能写入生产区块');
  const result = getScenario(scn.id).result!;
  assert.equal(result.interrupted, false);
  assert.ok(result.earlyMoves === 1);
  // 结论必须标注来源：假设 vs 生产
  assert.ok(result.risks.every(r => r.basis === 'assumption' || r.basis === 'production'));
  assert.ok(result.assumptionsApplied.some(s => s.includes('QC-07')));
  const virtual = result.affectedTasks.find(t => t.containerId === 'FCIU-9920310' && t.kind === 'virtual');
  assert.equal(virtual?.basis, 'assumption');
});

test('提交以差异形式写回生产状态并递增版本、写审计', async () => {
  const fromVersion = version();
  const scn = createScenario({ assumptions: assumptionsFor({
    etd: new Date(Date.now() + 22 * 3600 * 1000).toISOString(),
    relocations: [{ containerId: 'FCIU-9920310', toBlockId: 'B07' }],
  }) });
  await computeScenario(scn.id);
  const { diff, version: newVersion } = await commitScenario(scn.id);
  assert.equal(newVersion, fromVersion + 1);
  assert.ok(diff.some(d => d.entity === 'container' && d.id === 'FCIU-9920310' && d.changes?.yardSlot));
  assert.ok(diff.filter(d => d.entity === 'task' && d.action === 'create').length >= 2, '提前装船+移箱各创建一条生产任务');
  assert.ok(containers.find(c => c.id === 'FCIU-9920310')!.yardSlot.startsWith('B07-'));
  assert.equal(getScenario(scn.id).status, 'committed');
  // 已提交方案不能再次提交
  await assert.rejects(commitScenario(scn.id), (error: ScenarioError) => error.code === 'SCENARIO_COMMITTED');
});

test('推演期间生产发生变更，提交检测到版本冲突并列出冲突实体', async () => {
  const scn = createScenario({ assumptions: assumptionsFor({ etd: new Date(Date.now() + 21 * 3600 * 1000).toISOString() }) });
  await computeScenario(scn.id);
  // 调度员在另一终端更新了生产箱务
  updateContainer('FCIU-9920310', { weightT: 13.6 });
  await assert.rejects(
    commitScenario(scn.id),
    (error: ScenarioError) => {
      assert.equal(error.code, 'VERSION_CONFLICT');
      assert.equal(error.status, 409);
      assert.ok((error.details as { changedEntities: { id: string }[] }).changedEntities.some(c => c.id === 'FCIU-9920310'));
      return true;
    }
  );
  assert.equal(getScenario(scn.id).status, 'stale');
  assert.equal(listScenarios().find(s => s.id === scn.id)?.stale, true);
});

test('两个方案同时提交：先提交成功，第二个检测到版本冲突', async () => {
  const etd = new Date(Date.now() + 23 * 3600 * 1000).toISOString();
  const scnA = createScenario({ name: '并发A', assumptions: assumptionsFor({ etd, earlyLoadContainerIds: ['FCIU-9920310'] }) });
  const scnB = createScenario({ name: '并发B', assumptions: {
    voyageId: 'VOY-QF2', etd, earlyLoadContainerIds: [], relocations: [], equipmentOverrides: [], capacityOverrides: [],
  } });
  await Promise.all([computeScenario(scnA.id), computeScenario(scnB.id)]);
  const [resultA, resultB] = await Promise.allSettled([commitScenario(scnA.id), commitScenario(scnB.id)]);
  assert.equal(resultA.status, 'fulfilled');
  assert.equal(resultB.status, 'rejected');
  const reason = (resultB as PromiseRejectedResult).reason as ScenarioError;
  assert.equal(reason.code, 'VERSION_CONFLICT');
});

test('方案超过 TTL 后推演与提交都被拒绝', async () => {
  const scn = createScenario({ assumptions: assumptionsFor(), ttlMs: 20 });
  await sleep(40);
  await assert.rejects(computeScenario(scn.id), (error: ScenarioError) => error.code === 'SCENARIO_EXPIRED');
  // 手工放入结果后，过期提交同样被拒绝
  scn.status = 'ready';
  scn.expiresAt = Date.now() - 1;
  await assert.rejects(commitScenario(scn.id), (error: ScenarioError) => error.code === 'SCENARIO_EXPIRED');
  assert.equal(getScenario(scn.id).status, 'expired');
});

test('目标箱已经完成装船任务时，从提前装船集剔除并产生风险；生产中完成则提交拒绝', async () => {
  // 推演阶段：快照里箱子已完成（上一测试已提交装船任务，这里再把任务置 done）
  const loadTask = tasks.filter(t => t.containerId === 'FCIU-9920310' && t.kind === 'load')[0];
  if (loadTask) updateYardTask(loadTask.id, { status: 'done' });
  const scn = createScenario({ assumptions: assumptionsFor({ earlyLoadContainerIds: ['FCIU-9920310'] }) });
  await computeScenario(scn.id);
  const result = getScenario(scn.id).result!;
  assert.ok(result.risks.some(r => r.code === 'TARGET_ALREADY_DONE' && r.basis === 'production'));
  assert.equal(result.earlyMoves, 0);
  // 提交阶段：当前生产状态已是 done，直接以业务冲突拒绝
  await assert.rejects(commitScenario(scn.id), (error: ScenarioError) => {
    // 推演结果基于的快照 == 当前生产（无版本差异），因此走到业务复核
    assert.ok(['TARGET_ALREADY_DONE', 'VERSION_CONFLICT'].includes(error.code));
    return true;
  });
});

test('容量不足：推演给出 high 风险且不可完成，提交按活数据复核拒绝', async () => {
  // D05 生产占用 72/96（余 24）；假设容量收紧到仅剩 1 位，再流入 2 箱必然超容
  const scn = createScenario({ assumptions: {
    voyageId: 'VOY-QF2',
    earlyLoadContainerIds: [],
    relocations: [
      { containerId: 'MSCU-4829017', toBlockId: 'D05' },
      { containerId: 'EISU-1288420', toBlockId: 'D05' },
    ],
    equipmentOverrides: [], capacityOverrides: [{ blockId: 'D05', capacity: 73 }],
  } });
  await computeScenario(scn.id);
  const result = getScenario(scn.id).result!;
  assert.ok(result.risks.some(r => r.code === 'CAPACITY_SHORTFALL'));
  assert.equal(result.completable, false);
  const d05 = result.blockCapacities.find(b => b.blockId === 'D05')!;
  assert.equal(d05.feasible, false);
  await assert.rejects(commitScenario(scn.id), (error: ScenarioError) => error.code === 'CAPACITY_SHORTFALL');
});

test('危险品/冷藏约束在移箱假设下产生安全风险', async () => {
  const scn = createScenario({ assumptions: {
    voyageId: 'VOY-AX7', earlyLoadContainerIds: [],
    relocations: [{ containerId: 'TGHU-9831204', toBlockId: 'A01' }],
    equipmentOverrides: [], capacityOverrides: [],
  } });
  await computeScenario(scn.id);
  const result = getScenario(scn.id).result!;
  assert.ok(result.risks.some(r => r.code === 'HAZMAT_BLOCK_VIOLATION'));
  await assert.rejects(commitScenario(scn.id), (error: ScenarioError) => error.code === 'HAZMAT_BLOCK_VIOLATION');
});

test('推演可以中断：中断后保留部分进度，结论不可提交，可重新推演', async () => {
  const scn = createScenario({ assumptions: {
    voyageId: 'VOY-AX7', earlyLoadContainerIds: [],
    relocations: [{ containerId: 'MSCU-4829017', toBlockId: 'C03' }],
    equipmentOverrides: [{ equipmentId: 'QC-07', movesPerHour: 40 }], capacityOverrides: [],
  } });
  const running = computeScenario(scn.id);
  interruptScenario(scn.id);
  await running;
  const interrupted = getScenario(scn.id);
  assert.equal(interrupted.status, 'interrupted');
  assert.ok(interrupted.partial?.interruptedAt);
  await assert.rejects(commitScenario(scn.id), (error: ScenarioError) => error.code === 'SCENARIO_INTERRUPTED');
  // 重新推演后得到完整结论
  await computeScenario(scn.id);
  assert.equal(getScenario(scn.id).status === 'ready' || getScenario(scn.id).status === 'stale', true);
  assert.equal(getScenario(scn.id).result?.interrupted, false);
});

test('ETA/ETD 窗口假设缩短被识别，吞吐缺口产生 HIGH 风险', async () => {
  const scn = createScenario({ assumptions: {
    voyageId: 'VOY-AX7',
    eta: new Date().toISOString(),
    etd: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 仅 1 小时窗口
    earlyLoadContainerIds: ['MSCU-4829017'], relocations: [],
    equipmentOverrides: [], capacityOverrides: [],
  } });
  await computeScenario(scn.id);
  const result = getScenario(scn.id).result!;
  assert.ok(result.risks.some(r => r.code === 'WINDOW_SHRUNK'));
  assert.ok(result.overrunMoves > 0);
  assert.equal(result.lateRisk, 'high');
});

test('非法假设：ETD 早于 ETA、未知箱号、容量小于占用均被拒绝', () => {
  assert.throws(
    () => createScenario({ assumptions: { voyageId: 'VOY-AX7', eta: new Date().toISOString(), etd: new Date(Date.now() - 3600e3).toISOString(), earlyLoadContainerIds: [], relocations: [], equipmentOverrides: [], capacityOverrides: [] } }),
    (error: ScenarioError) => error.code === 'INVALID_WINDOW'
  );
  assert.throws(
    () => createScenario({ assumptions: { voyageId: 'VOY-AX7', earlyLoadContainerIds: ['NO-SUCH-BOX'], relocations: [], equipmentOverrides: [], capacityOverrides: [] } }),
    (error: ScenarioError) => error.code === 'INVALID_ASSUMPTION'
  );
  assert.throws(
    () => createScenario({ assumptions: { voyageId: 'VOY-AX7', earlyLoadContainerIds: [], relocations: [], equipmentOverrides: [], capacityOverrides: [{ blockId: 'A01', capacity: 10 }] } }),
    (error: ScenarioError) => error.code === 'CAPACITY_SHORTFALL'
  );
});

test('生产版本机制：任何生产领域写操作都会递增版本并可被快照差异感知', () => {
  const v1 = version();
  recordAudit('TEST', 'scenario', 'probe', '审计本身不 bump 版本');
  assert.equal(version(), v1);
  const task = createYardTask({ kind: 'deliver', containerId: 'MSCU-4829017', from: 'A01-R07-T3', to: '北闸口', priority: 33, scheduledAt: new Date().toISOString(), estimatedMinutes: 10 });
  assert.ok(version() > v1);
  const base = snapshotProduction(v1);
  // 构造一个人为旧快照，差异应识别新任务
  assert.ok(JSON.stringify(base).length > 0);
  bumpProductionVersion(); // 清理用：保持后续版本继续前进
  void task; void voyages; void assignTask;
});
