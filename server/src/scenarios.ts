import {
  appointments, blocks, containers, equipment, tasks, voyages,
  auditEvents, getProductionVersion, bumpProductionVersion, recordAudit,
  type Container, type Equipment, type GateAppointment, type YardBlock, type YardTask, type Voyage
} from './domain.js';

/* ------------------------------------------------------------------ */
/* 类型定义                                                             */
/* ------------------------------------------------------------------ */

export interface StateSnapshot {
  version: number;
  voyages: Voyage[];
  containers: Container[];
  blocks: YardBlock[];
  equipment: Equipment[];
  tasks: YardTask[];
  appointments: GateAppointment[];
}

/** 推演假设：靠泊窗口（ETA/ETD）、提前装船目标箱集、移箱目标区块、设备能力、区块容量 */
export interface ScenarioAssumptions {
  voyageId: string;
  eta?: string;
  etd?: string;
  earlyLoadContainerIds: string[];
  relocations: { containerId: string; toBlockId: string }[];
  equipmentOverrides: { equipmentId: string; movesPerHour?: number; status?: Equipment['status'] }[];
  capacityOverrides: { blockId: string; capacity?: number; occupied?: number }[];
  note?: string;
}

export type ConclusionBasis = 'production' | 'assumption';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ScenarioRisk {
  level: RiskLevel;
  code: string;
  message: string;
  basis: ConclusionBasis;
}

export interface AffectedTask {
  taskId?: string;
  kind: YardTask['kind'] | 'virtual';
  containerId: string;
  from: string;
  to: string;
  change: string;
  basis: ConclusionBasis;
  status: string;
  scheduledShiftMin?: number;
  blockingReasons: string[];
}

export interface BlockCapacityLine {
  blockId: string;
  capacity: number;
  occupied: number;
  utilization: number;
  freeSlots: number;
  deltaIn: number;
  deltaOut: number;
  feasible: boolean;
  basis: ConclusionBasis;
}

export interface ProjectionResult {
  windowMinutes: number;
  windowBaselineMinutes: number;
  remainingMoves: number;
  remainingMovesBaseline: number;
  earlyMoves: number;
  relocationMoves: number;
  throughputMoves: number;
  completable: boolean;
  overrunMoves: number;
  equipmentCapacityMph: number;
  lateRisk: RiskLevel;
  risks: ScenarioRisk[];
  affectedTasks: AffectedTask[];
  blockCapacities: BlockCapacityLine[];
  assumptionsApplied: string[];
  computedAt: string;
  interrupted: false;
}

export interface PartialProjection {
  interrupted: true;
  interruptedAt: string;
  progress: string;
  partial?: {
    remainingMoves: number;
    relocationMoves: number;
    earlyMoves: number;
    risksCount: number;
  };
}

export interface AppliedDiffEntry {
  entity: 'voyage' | 'container' | 'block' | 'equipment' | 'task';
  id: string;
  action: 'update' | 'create';
  changes?: Record<string, { from: unknown; to: unknown }>;
  payload?: Record<string, unknown>;
  basis: ConclusionBasis;
}

export type ScenarioStatus = 'draft' | 'computing' | 'ready' | 'interrupted' | 'stale' | 'committed' | 'expired';

export interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: number;
  baseVersion: number;
  baseFingerprint: string;
  assumptions: ScenarioAssumptions;
  snapshot: StateSnapshot;
  status: ScenarioStatus;
  result?: ProjectionResult;
  partial?: PartialProjection;
  lastError?: { code: string; message: string };
  commit?: { committedAt: string; version: number; diff: AppliedDiffEntry[] };
  abort?: AbortController;
}

/** 携带 HTTP 状态码与机器可读错误码的业务异常 */
export class ScenarioError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* 生产状态快照与版本指纹                                                 */
/* ------------------------------------------------------------------ */

export function snapshotProduction(version = getProductionVersion()): StateSnapshot {
  return {
    version,
    voyages: structuredClone(voyages),
    containers: structuredClone(containers),
    blocks: structuredClone(blocks),
    equipment: structuredClone(equipment),
    tasks: structuredClone(tasks),
    appointments: structuredClone(appointments),
  };
}

/** FNV-1a 32 位哈希：对当前生产实体逐条求指纹，粒度可到单箱/单任务 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

const fingerprintEntity = (rows: { id: string }[]) =>
  rows.map(row => `${row.id}:${fnv1a(JSON.stringify(row))}`).join('|');

export function stateFingerprint(state: { voyages: { id: string }[]; containers: { id: string }[]; blocks: { id: string }[]; equipment: { id: string }[]; tasks: { id: string }[]; appointments: { id: string }[] }) {
  return fnv1a(['V', fingerprintEntity(state.voyages), 'C', fingerprintEntity(state.containers), 'B', fingerprintEntity(state.blocks),
    'E', fingerprintEntity(state.equipment), 'T', fingerprintEntity(state.tasks), 'A', fingerprintEntity(state.appointments)].join(''));
}

/** 比对沙盘基线快照与当前生产状态，列出真正发生变化、可能与提交冲突的实体 */
export function diffSnapshot(base: StateSnapshot, live: StateSnapshot) {
  const changes: { entity: string; id: string; type: string }[] = [];
  const rows = <T extends { id: string }>(entity: string, before: T[], after: T[]) => {
    const beforeMap = new Map(before.map(item => [item.id, item]));
    const afterMap = new Map(after.map(item => [item.id, item]));
    for (const item of after) {
      const old = beforeMap.get(item.id);
      if (!old) changes.push({ entity, id: item.id, type: 'created' });
      else if (fnv1a(JSON.stringify(old)) !== fnv1a(JSON.stringify(item))) changes.push({ entity, id: item.id, type: 'updated' });
    }
    for (const item of before) if (!afterMap.has(item.id)) changes.push({ entity, id: item.id, type: 'deleted' });
  };
  rows('voyage', base.voyages, live.voyages);
  rows('container', base.containers, live.containers);
  rows('block', base.blocks, live.blocks);
  rows('equipment', base.equipment, live.equipment);
  rows('task', base.tasks, live.tasks);
  rows('appointment', base.appointments, live.appointments);
  return changes;
}

/* ------------------------------------------------------------------ */
/* 沙盘存储与生命周期                                                     */
/* ------------------------------------------------------------------ */

const scenarios = new Map<string, Scenario>();
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const ACTIVE_STATUSES: ScenarioStatus[] = ['draft', 'computing', 'ready', 'interrupted', 'stale'];

function touch(scenario: Scenario, now = Date.now()): Scenario {
  if (scenario.status === 'committed' || scenario.status === 'expired') return scenario;
  if (now > scenario.expiresAt) {
    if (scenario.abort) scenario.abort.abort();
    scenario.abort = undefined;
    scenario.status = 'expired';
  }
  return scenario;
}

function requireScenario(id: string): Scenario {
  const scenario = scenarios.get(id);
  if (!scenario) throw new ScenarioError(404, 'SCENARIO_NOT_FOUND', `方案 ${id} 不存在或已被清理`);
  return touch(scenario);
}

export function listScenarios(): (Pick<Scenario, 'id' | 'name' | 'status' | 'createdAt' | 'baseVersion' | 'expiresAt'> & {
  currentVersion: number; stale: boolean; expiresInMs: number; hasResult: boolean; voyageId: string;
})[] {
  const currentVersion = getProductionVersion();
  return [...scenarios.values()]
    .map(scenario => {
      touch(scenario);
      return {
        id: scenario.id, name: scenario.name, status: scenario.status, createdAt: scenario.createdAt,
        baseVersion: scenario.baseVersion, expiresAt: scenario.expiresAt,
        currentVersion, stale: scenario.baseVersion !== currentVersion && scenario.status !== 'committed',
        expiresInMs: Math.max(0, scenario.expiresAt - Date.now()), hasResult: Boolean(scenario.result), voyageId: scenario.assumptions.voyageId,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getScenario(id: string): Scenario { return requireScenario(id); }

export function deleteScenario(id: string) {
  const scenario = requireScenario(id);
  if (scenario.status === 'committed') throw new ScenarioError(409, 'SCENARIO_COMMITTED', '已提交方案不能删除，它代表一次生产变更记录');
  scenario.abort?.abort();
  scenarios.delete(id);
  return { deleted: true, id };
}

/* ------------------------------------------------------------------ */
/* 假设校验与规范化                                                       */
/* ------------------------------------------------------------------ */

function normalizeAssumptions(input: Partial<ScenarioAssumptions>, snapshot: StateSnapshot): ScenarioAssumptions {
  const voyageId = String(input.voyageId || '').trim();
  const voyage = snapshot.voyages.find(v => v.id === voyageId);
  if (!voyage) throw new ScenarioError(400, 'INVALID_ASSUMPTION', `航次 ${voyageId || '(空)'} 不存在`);

  const eta = input.eta ? new Date(input.eta) : undefined;
  const etd = input.etd ? new Date(input.etd) : undefined;
  if ((eta && Number.isNaN(eta.getTime())) || (etd && Number.isNaN(etd.getTime())))
    throw new ScenarioError(400, 'INVALID_ASSUMPTION', 'ETA/ETD 时间格式无法解析');
  if (eta && etd && etd <= eta)
    throw new ScenarioError(422, 'INVALID_WINDOW', 'ETD 必须晚于 ETA，靠泊窗口不能为零或为负', { eta: input.eta, etd: input.etd });

  const ids = (list?: string[]) => Array.from(new Set((list ?? []).map(id => String(id).trim()).filter(Boolean)));
  const earlyLoadContainerIds = ids(input.earlyLoadContainerIds);
  const unknownEarly = earlyLoadContainerIds.filter(id => !snapshot.containers.some(c => c.id === id));
  if (unknownEarly.length) throw new ScenarioError(400, 'INVALID_ASSUMPTION', `提前装船目标箱不存在：${unknownEarly.join('、')}`);

  const relocations = (input.relocations ?? [])
    .map(item => ({ containerId: String(item.containerId || '').trim(), toBlockId: String(item.toBlockId || '').trim() }))
    .filter(item => item.containerId && item.toBlockId);
  const seenReloc = new Set<string>();
  for (const item of relocations) {
    if (seenReloc.has(item.containerId)) throw new ScenarioError(400, 'INVALID_ASSUMPTION', `箱 ${item.containerId} 在同一方案中指定了多个目标区块`);
    seenReloc.add(item.containerId);
    if (!snapshot.containers.some(c => c.id === item.containerId)) throw new ScenarioError(400, 'INVALID_ASSUMPTION', `移箱目标箱 ${item.containerId} 不存在`);
    if (!snapshot.blocks.some(b => b.id === item.toBlockId)) throw new ScenarioError(400, 'INVALID_ASSUMPTION', `目标区块 ${item.toBlockId} 不存在`);
  }

  const equipmentOverrides = input.equipmentOverrides ?? [];
  for (const override of equipmentOverrides) {
    if (!snapshot.equipment.some(e => e.id === override.equipmentId))
      throw new ScenarioError(400, 'INVALID_ASSUMPTION', `设备 ${override.equipmentId} 不存在`);
    if (override.movesPerHour !== undefined && override.movesPerHour < 0)
      throw new ScenarioError(422, 'INVALID_ASSUMPTION', '设备作业能力不能为负');
  }

  const capacityOverrides = input.capacityOverrides ?? [];
  for (const override of capacityOverrides) {
    const block = snapshot.blocks.find(b => b.id === override.blockId);
    if (!block) throw new ScenarioError(400, 'INVALID_ASSUMPTION', `区块 ${override.blockId} 不存在`);
    const occupied = override.occupied ?? block.occupied;
    const capacity = override.capacity ?? block.capacity;
    if (capacity < 0 || occupied < 0) throw new ScenarioError(422, 'INVALID_ASSUMPTION', '容量/占用不能为负');
    if (occupied > capacity)
      throw new ScenarioError(422, 'CAPACITY_SHORTFALL', `区块 ${override.blockId} 假设占用 ${occupied} 已超过假设容量 ${capacity}`, { blockId: override.blockId, capacity, occupied });
  }

  return {
    voyageId,
    eta: eta?.toISOString(), etd: etd?.toISOString(),
    earlyLoadContainerIds,
    relocations,
    equipmentOverrides: equipmentOverrides.map(o => ({ ...o })),
    capacityOverrides: capacityOverrides.map(o => ({ ...o })),
    note: input.note ? String(input.note) : undefined,
  };
}

export function createScenario(input: { name?: string; assumptions: Partial<ScenarioAssumptions>; ttlMs?: number }): Scenario {
  const snapshot = snapshotProduction();
  const assumptions = normalizeAssumptions(input.assumptions, snapshot);
  const ttl = input.ttlMs && input.ttlMs > 0 ? input.ttlMs : DEFAULT_TTL_MS;
  const id = `SCN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
  const scenario: Scenario = {
    id,
    name: input.name?.trim() || `推演 ${assumptions.voyageId} · ${new Date().toLocaleTimeString()}`,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + ttl,
    baseVersion: snapshot.version,
    baseFingerprint: stateFingerprint(snapshot),
    assumptions,
    snapshot,
    status: 'draft',
  };
  scenarios.set(id, scenario);
  recordAudit('SCENARIO_CREATE', 'scenario', id, `创建隔离方案副本（基线版本 v${snapshot.version}），未触碰生产状态`);
  return scenario;
}

export function updateAssumptions(id: string, patch: Partial<ScenarioAssumptions>) {
  const scenario = requireScenario(id);
  if (scenario.status === 'committed' || scenario.status === 'expired')
    throw new ScenarioError(409, `SCENARIO_${scenario.status.toUpperCase()}`, `方案已${scenario.status === 'committed' ? '提交' : '过期'}，假设不可修改`);
  if (scenario.status === 'computing') throw new ScenarioError(409, 'SCENARIO_COMPUTING', '方案正在推演，请先中断再修改假设');
  scenario.assumptions = normalizeAssumptions({ ...scenario.assumptions, ...patch }, scenario.snapshot);
  scenario.status = 'draft';
  scenario.result = undefined;
  scenario.partial = undefined;
  scenario.lastError = undefined;
  return scenario;
}

/* ------------------------------------------------------------------ */
/* 推演投影：纯函数，只在副本上计算，绝不触碰生产数据                        */
/* ------------------------------------------------------------------ */

const parseBlockId = (slot: string) => slot.match(/^([A-Z]\d\d)-/)?.[1];

/** 已完成装船任务的箱子视为"已经完成任务"，不能再纳入提前装船 */
function earlyLoadDone(container: Container, stateTasks: YardTask[]) {
  const loadTask = stateTasks.find(t => t.containerId === container.id && t.kind === 'load');
  return loadTask?.status === 'done' || container.status === 'on-quay';
}

function checkpoint(signal: AbortSignal, phase: string, tick: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      tick();
      if (signal.aborted) {
        const error = new Error(phase);
        error.name = 'AbortError';
        reject(error);
      } else resolve();
    }, 4);
  });
}

/**
 * 在隔离快照上应用假设并做投影。
 * 所有返回结论都带 basis：production=来自快照中当前生产状态；assumption=来自本方案假设。
 */
export async function projectScenario(scenario: Scenario): Promise<ProjectionResult> {
  const signal = scenario.abort!.signal;
  const state: StateSnapshot = structuredClone(scenario.snapshot);
  const a = scenario.assumptions;
  const applied: string[] = [];
  const risks: ScenarioRisk[] = [];

  const voyage = state.voyages.find(v => v.id === a.voyageId)!;
  const eta = a.eta ? new Date(a.eta) : new Date(voyage.eta);
  const etd = a.etd ? new Date(a.etd) : new Date(voyage.etd);

  /* —— 阶段 1：窗口假设 —— */
  await checkpoint(signal, '窗口与基础量', () => {});
  if (a.eta) { voyage.eta = eta.toISOString(); applied.push(`ETA 假设调整为 ${eta.toLocaleString()}`); }
  if (a.etd) { voyage.etd = etd.toISOString(); applied.push(`ETD 假设调整为 ${etd.toLocaleString()}`); }
  const windowMinutes = Math.max(0, (etd.getTime() - eta.getTime()) / 60000);
  const windowBaselineMinutes = (new Date(scenario.snapshot.voyages.find(v => v.id === a.voyageId)!.etd).getTime()
    - new Date(scenario.snapshot.voyages.find(v => v.id === a.voyageId)!.eta).getTime()) / 60000;
  if (windowMinutes < windowBaselineMinutes)
    risks.push({ level: windowBaselineMinutes - windowMinutes > 60 ? 'high' : 'medium', code: 'WINDOW_SHRUNK', message: `靠泊窗口较生产计划缩短 ${Math.round(windowBaselineMinutes - windowMinutes)} 分钟`, basis: 'assumption' });
  const remainingMovesBaseline = voyage.movesPlanned - voyage.movesDone;

  /* —— 阶段 2：提前装船箱集 —— */
  let earlyMoves = 0;
  const earlyDone: string[] = [];
  const earlyEligible: Container[] = [];
  for (const id of a.earlyLoadContainerIds) {
    const container = state.containers.find(c => c.id === id);
    if (!container) continue;
    if (earlyLoadDone(container, state.tasks)) {
      earlyDone.push(id);
      risks.push({ level: 'medium', code: 'TARGET_ALREADY_DONE', message: `箱 ${id} 装船任务已完成（或已在船边），提前装船假设对其无效，已从目标集剔除`, basis: 'production' });
    } else {
      earlyEligible.push(container);
    }
  }
  await checkpoint(signal, '提前装船箱集评估', () => {});
  for (const container of earlyEligible) {
    state.tasks.push({
      id: `virtual-load-${container.id}`, kind: 'load', containerId: container.id, from: container.yardSlot,
      to: `${voyage.berth} / ${voyage.id}`, priority: 90, status: 'queued',
      scheduledAt: new Date(eta.getTime() + 30 * 60000).toISOString(), blockingReasons: [], estimatedMinutes: 8,
    });
    earlyMoves += 1;
    applied.push(`箱 ${container.id} 提前装船（+1 move）`);
  }

  /* —— 阶段 3：移箱假设与区块容量 —— */
  let relocationMoves = 0;
  const relocByBlock = new Map<string, { in: Container[]; out: Container[] }>();
  for (const block of state.blocks) relocByBlock.set(block.id, { in: [], out: [] });
  await checkpoint(signal, '移箱与容量推演', () => {});
  for (const reloc of a.relocations) {
    const container = state.containers.find(c => c.id === reloc.containerId)!;
    const target = state.blocks.find(b => b.id === reloc.toBlockId)!;
    const fromBlockId = parseBlockId(container.yardSlot);
    if (fromBlockId) relocByBlock.get(fromBlockId)?.out.push(container);
    relocByBlock.get(reloc.toBlockId)!.in.push(container);
    relocationMoves += 2; // 一次移箱：场桥取出 + 集卡转运落位
    const oldSlot = container.yardSlot;
    container.yardSlot = `${reloc.toBlockId}-R99-T1`;
    state.tasks.push({
      id: `virtual-rehandle-${container.id}`, kind: 'rehandle', containerId: container.id, from: oldSlot,
      to: container.yardSlot, priority: 85, status: 'queued',
      scheduledAt: new Date(eta.getTime() + 15 * 60000).toISOString(), blockingReasons: [], estimatedMinutes: 12,
    });
    applied.push(`箱 ${container.id} 移至区块 ${reloc.toBlockId}（取出+落位 +2 moves）`);
    if (container.reefer) {
      if (target.reeferPlugs - target.usedPlugs < 1)
        risks.push({ level: 'high', code: 'REEFER_PLUG_SHORTFALL', message: `区块 ${reloc.toBlockId} 假设下无可用冷藏插座，冷藏箱 ${container.id} 无法落位`, basis: 'assumption' });
    }
    if (container.hazmatClass && !target.hazmatAllowed)
      risks.push({ level: 'high', code: 'HAZMAT_BLOCK_VIOLATION', message: `区块 ${reloc.toBlockId} 无危险品隔离资质，危险品箱 ${container.id}（${container.hazmatClass} 类）不能移入`, basis: 'assumption' });
  }

  /* —— 阶段 4：设备能力假设与吞吐 —— */
  await checkpoint(signal, '设备能力与吞吐计算', () => {});
  const effectiveEquipment = state.equipment.map(item => {
    const override = a.equipmentOverrides.find(o => o.equipmentId === item.id);
    if (override) {
      if (override.movesPerHour !== undefined) item.movesPerHour = override.movesPerHour;
      if (override.status) item.status = override.status;
      applied.push(`设备 ${item.id} 假设能力 ${override.movesPerHour !== undefined ? `${item.movesPerHour} moves/h` : '不变'}${override.status ? `、状态 ${item.status}` : ''}`);
    }
    return item;
  });
  const quayCranes = effectiveEquipment.filter(e => e.kind === 'quay-crane' && e.status !== 'maintenance' && e.status !== 'offline');
  if (!quayCranes.length) {
    risks.push({ level: 'high', code: 'NO_QUAY_CRANE', message: '假设下没有可用岸桥，靠泊窗口内无法完成装船作业', basis: 'assumption' });
  }
  // 岸桥在窗口内并非 100% 运转，按 85% 有效利用率估算
  const qcMph = quayCranes.reduce((sum, qc) => sum + qc.movesPerHour, 0);
  const equipmentCapacityMph = qcMph;
  const throughputMoves = Math.round(qcMph * (windowMinutes / 60) * 0.85);

  const capacityShortfalls: ScenarioRisk[] = [];
  const blockCapacities: BlockCapacityLine[] = state.blocks.map(block => {
    const override = a.capacityOverrides.find(o => o.blockId === block.id);
    const basis: ConclusionBasis = override || relocByBlock.get(block.id)!.in.length || relocByBlock.get(block.id)!.out.length ? 'assumption' : 'production';
    if (override?.capacity !== undefined) { block.capacity = override.capacity; applied.push(`区块 ${block.id} 假设容量 ${block.capacity}`); }
    if (override?.occupied !== undefined) { block.occupied = override.occupied; applied.push(`区块 ${block.id} 假设占用 ${block.occupied}`); }
    const flow = relocByBlock.get(block.id)!;
    const occupied = block.occupied + flow.in.length - flow.out.length;
    const freeSlots = block.capacity - occupied;
    if (freeSlots < 0)
      capacityShortfalls.push({ level: 'high', code: 'CAPACITY_SHORTFALL', message: `区块 ${block.id} 假设下容量不足：流入 ${flow.in.length}、流出 ${flow.out.length} 后超容 ${-freeSlots} 箱`, basis: 'assumption' });
    return {
      blockId: block.id, capacity: block.capacity, occupied, utilization: block.capacity ? occupied / block.capacity : 0,
      freeSlots, deltaIn: flow.in.length, deltaOut: flow.out.length, feasible: freeSlots >= 0, basis,
    };
  });
  risks.push(...capacityShortfalls);

  /* —— 阶段 5：汇总剩余 moves、风险与受影响任务 —— */
  await checkpoint(signal, '风险与任务汇总', () => {});
  const remainingMoves = remainingMovesBaseline + earlyMoves + relocationMoves;
  const overrunMoves = Math.max(0, remainingMoves - throughputMoves);
  const completable = !capacityShortfalls.length && quayCranes.length > 0
    && !risks.some(r => r.code === 'HAZMAT_BLOCK_VIOLATION' || r.code === 'REEFER_PLUG_SHORTFALL')
    && overrunMoves === 0;
  let lateRisk: RiskLevel = voyage.lateRisk;
  if (overrunMoves > 0) lateRisk = 'high';
  else if (overrunMoves === 0 && (windowMinutes < windowBaselineMinutes || capacityShortfalls.length)) lateRisk = 'medium';
  if (overrunMoves > 0)
    risks.push({ level: 'high', code: 'THROUGHPUT_GAP', message: `窗口内岸桥预计完成 ${throughputMoves} moves，剩余作业 ${remainingMoves} moves，缺口 ${overrunMoves} moves`, basis: 'assumption' });
  else
    risks.push({ level: 'low', code: 'THROUGHPUT_OK', message: `窗口内岸桥预计完成 ${throughputMoves} moves，可覆盖剩余 ${remainingMoves} moves`, basis: 'assumption' });
  if (earlyEligible.length)
    risks.push({ level: 'low', code: 'EARLY_LOAD_PLAN', message: `${earlyEligible.length} 个目标箱假设提前装船，需在 ETA 后优先调度岸桥`, basis: 'assumption' });

  const virtualIds = new Set<string>();
  const affectedTasks: AffectedTask[] = [];
  for (const task of state.tasks) {
    const isVirtual = task.id.startsWith('virtual-');
    if (isVirtual) virtualIds.add(task.id);
    const touched = isVirtual || a.earlyLoadContainerIds.includes(task.containerId)
      || a.relocations.some(r => r.containerId === task.containerId);
    if (!touched) continue;
    const baseTask = scenario.snapshot.tasks.find(t => t.id === task.id);
    let change: string;
    let basis: ConclusionBasis;
    if (isVirtual) {
      change = task.kind === 'load' ? '提前装船假设新增的装船任务' : '移箱假设新增的翻箱任务';
      basis = 'assumption';
    } else if (baseTask && new Date(baseTask.scheduledAt).getTime() !== new Date(task.scheduledAt).getTime()) {
      change = '计划时间随假设窗口平移';
      basis = 'assumption';
    } else {
      change = '目标箱集变化，该任务的优先级/资源分配受影响';
      basis = 'assumption';
    }
    affectedTasks.push({
      taskId: isVirtual ? undefined : task.id, kind: isVirtual ? 'virtual' : task.kind, containerId: task.containerId,
      from: task.from, to: task.to, change, basis, status: task.status, blockingReasons: [...task.blockingReasons],
    });
  }
  // 窗口变化会平移航次相关、尚未开始的既有任务
  const windowShiftMin = Math.round((eta.getTime() - new Date(scenario.snapshot.voyages.find(v => v.id === a.voyageId)!.eta).getTime()) / 60000);
  if (windowShiftMin !== 0) {
    for (const task of state.tasks) {
      if (virtualIds.has(task.id) || task.status === 'done' || affectedTasks.some(x => x.taskId === task.id)) continue;
      const container = state.containers.find(c => c.id === task.containerId);
      if (container?.voyageId !== a.voyageId) continue;
      affectedTasks.push({
        taskId: task.id, kind: task.kind, containerId: task.containerId, from: task.from, to: task.to,
        change: `ETA 调整导致计划时间平移 ${windowShiftMin > 0 ? '+' : ''}${windowShiftMin} 分钟`,
        basis: 'assumption', status: task.status, scheduledShiftMin: windowShiftMin, blockingReasons: [...task.blockingReasons],
      });
    }
  }
  affectedTasks.sort((x, y) => (x.basis === y.basis ? 0 : x.basis === 'assumption' ? -1 : 1));

  return {
    windowMinutes: Math.round(windowMinutes), windowBaselineMinutes: Math.round(windowBaselineMinutes),
    remainingMoves, remainingMovesBaseline, earlyMoves, relocationMoves, throughputMoves,
    completable, overrunMoves, equipmentCapacityMph: Math.round(equipmentCapacityMph * 10) / 10,
    lateRisk, risks, affectedTasks, blockCapacities, assumptionsApplied: applied,
    computedAt: new Date().toISOString(), interrupted: false,
  };
}

/* ------------------------------------------------------------------ */
/* 异步推演调度（可中断）与错误分类                                        */
/* ------------------------------------------------------------------ */

export function isAbortError(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'AbortError';
}

export async function computeScenario(id: string): Promise<Scenario> {
  const scenario = requireScenario(id);
  if (scenario.status === 'committed' || scenario.status === 'expired')
    throw new ScenarioError(409, `SCENARIO_${scenario.status.toUpperCase()}`, `方案已${scenario.status === 'committed' ? '提交' : '过期'}，不能推演`);
  if (scenario.status === 'computing') throw new ScenarioError(409, 'SCENARIO_COMPUTING', '方案正在推演中，请勿重复触发');
  scenario.abort?.abort();
  const controller = new AbortController();
  scenario.abort = controller;
  scenario.status = 'computing';
  scenario.partial = undefined;
  scenario.lastError = undefined;

  try {
    const result = await projectScenario(scenario);
    if (controller.signal.aborted) {
      scenario.status = 'interrupted';
      scenario.partial = { interrupted: true, interruptedAt: new Date().toISOString(), progress: '计算已中断', partial: { remainingMoves: result.remainingMoves, relocationMoves: result.relocationMoves, earlyMoves: result.earlyMoves, risksCount: result.risks.length } };
      return scenario;
    }
    scenario.result = result;
    scenario.partial = undefined;
    scenario.status = scenario.baseVersion !== getProductionVersion() ? 'stale' : 'ready';
    return scenario;
  } catch (reason) {
    if (isAbortError(reason)) {
      scenario.status = 'interrupted';
      scenario.partial = { interrupted: true, interruptedAt: new Date().toISOString(), progress: `推演在「${(reason as Error).message}」阶段被中断，可调整假设后重新推演` };
      return scenario;
    }
    if (reason instanceof ScenarioError) { scenario.lastError = { code: reason.code, message: reason.message }; scenario.status = 'draft'; throw reason; }
    scenario.status = 'interrupted';
    scenario.lastError = { code: 'COMPUTATION_FAILED', message: reason instanceof Error ? reason.message : '推演计算失败' };
    throw new ScenarioError(500, 'COMPUTATION_FAILED', scenario.lastError.message);
  } finally {
    if (scenario.abort === controller) scenario.abort = undefined;
  }
}

export function interruptScenario(id: string): Scenario {
  const scenario = requireScenario(id);
  if (scenario.status !== 'computing') throw new ScenarioError(409, 'SCENARIO_NOT_COMPUTING', '只有推演中的方案可以中断');
  scenario.abort?.abort();
  return scenario;
}

/* ------------------------------------------------------------------ */
/* 方案提交：版本冲突检测 + 业务复核 + 互斥串行                            */
/* ------------------------------------------------------------------ */

let commitChain: Promise<unknown> = Promise.resolve();
/** 全局提交互斥：两个方案同时提交时，第二个必然检测到版本冲突或排队失败 */
export function withCommitLock<T>(label: string, task: () => Promise<T>): Promise<T> {
  const run = commitChain.then(() => task());
  // 不让单个提交的失败中断整条链
  commitChain = run.then(() => undefined, () => undefined);
  void label;
  return run;
}

/** 对照当前生产状态复核假设；返回按当前生产数据重算的容量检查结果 */
function validateAgainstLive(assumptions: ScenarioAssumptions, live: StateSnapshot) {
  const completed = assumptions.earlyLoadContainerIds.filter(id => {
    const container = live.containers.find(c => c.id === id);
    if (!container) return true; // 箱已被删除也视为目标失效
    return earlyLoadDone(container, live.tasks);
  });
  if (completed.length)
    throw new ScenarioError(409, 'TARGET_ALREADY_DONE', `目标箱在推演期间已完成作业或已被删除：${completed.join('、')}`, { containerIds: completed });

  const capacityByBlock = new Map(live.blocks.map(b => [b.id, { block: b, in: 0, out: 0 }]));
  for (const reloc of assumptions.relocations) {
    const container = live.containers.find(c => c.id === reloc.containerId);
    if (!container) throw new ScenarioError(409, 'TARGET_ALREADY_DONE', `移箱目标 ${reloc.containerId} 在生产状态中已不存在`, { containerIds: [reloc.containerId] });
    const from = parseBlockId(container.yardSlot);
    if (from && capacityByBlock.has(from)) capacityByBlock.get(from)!.out += 1;
    if (!capacityByBlock.has(reloc.toBlockId)) throw new ScenarioError(409, 'BLOCK_MISSING', `目标区块 ${reloc.toBlockId} 在生产状态中已不存在`);
    capacityByBlock.get(reloc.toBlockId)!.in += 1;
  }
  const overloaded: { blockId: string; freeSlots: number }[] = [];
  for (const [blockId, flow] of capacityByBlock) {
    const override = assumptions.capacityOverrides.find(o => o.blockId === blockId);
    const capacity = override?.capacity ?? flow.block.capacity;
    const occupied = (override?.occupied ?? flow.block.occupied) + flow.in - flow.out;
    if (occupied > capacity) overloaded.push({ blockId, freeSlots: capacity - occupied });
  }
  if (overloaded.length)
    throw new ScenarioError(422, 'CAPACITY_SHORTFALL', `按当前生产状态复核，区块容量不足：${overloaded.map(o => `${o.blockId}（超容 ${-o.freeSlots}）`).join('、')}`, { blocks: overloaded });

  for (const reloc of assumptions.relocations) {
    const container = live.containers.find(c => c.id === reloc.containerId)!;
    const target = live.blocks.find(b => b.id === reloc.toBlockId)!;
    if (container.hazmatClass && !target.hazmatAllowed)
      throw new ScenarioError(422, 'HAZMAT_BLOCK_VIOLATION', `区块 ${reloc.toBlockId} 无危险品隔离资质，不能移入 ${container.id}`);
    if (container.reefer && target.reeferPlugs - target.usedPlugs < 1)
      throw new ScenarioError(422, 'REEFER_PLUG_SHORTFALL', `区块 ${reloc.toBlockId} 没有空闲冷藏插座，不能移入冷藏箱 ${container.id}`);
  }
  for (const override of assumptions.equipmentOverrides) {
    if (!live.equipment.some(e => e.id === override.equipmentId))
      throw new ScenarioError(409, 'EQUIPMENT_MISSING', `设备 ${override.equipmentId} 在生产状态中已不存在`);
  }
}

function diffEntry<T extends Record<string, unknown>>(before: T, after: T): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}

export function commitScenario(id: string, actor = '中控调度员'): Promise<{ id: string; version: number; diff: AppliedDiffEntry[]; conflicts?: unknown }> {
  return withCommitLock(`commit:${id}`, async () => {
    const scenario = requireScenario(id);
    if (scenario.status === 'expired') throw new ScenarioError(409, 'SCENARIO_EXPIRED', `方案已超过 ${Math.round((DEFAULT_TTL_MS) / 60000)} 分钟有效期，请基于当前生产状态重建`);
    if (scenario.status === 'committed') throw new ScenarioError(409, 'SCENARIO_COMMITTED', '方案已提交，请勿重复提交');
    if (scenario.status === 'computing') throw new ScenarioError(409, 'SCENARIO_COMPUTING', '方案仍在推演，请等待完成或先中断');
    if (scenario.status === 'interrupted') throw new ScenarioError(409, 'SCENARIO_INTERRUPTED', '推演被中断，结论不完整，请重新推演后再提交');
    if (!scenario.result) throw new ScenarioError(409, 'SCENARIO_NOT_READY', '方案尚未完成推演，没有可提交的结论');

    /* 1. 乐观锁：版本号 + 逐条实体指纹，定位推演期间发生的生产变更 */
    const live = snapshotProduction();
    if (live.version !== scenario.baseVersion || stateFingerprint(live) !== scenario.baseFingerprint) {
      const changed = diffSnapshot(scenario.snapshot, live);
      scenario.status = 'stale';
      throw new ScenarioError(409, 'VERSION_CONFLICT',
        `生产状态已从 v${scenario.baseVersion} 变更到 v${live.version}，方案基线过期，请查看冲突实体后重建或放弃`,
        { baseVersion: scenario.baseVersion, currentVersion: live.version, changedEntities: changed });
    }

    /* 2. 对照活数据复核业务约束（箱已完成 / 容量不足 / 危险品 / 冷插 / 设备缺失） */
    validateAgainstLive(scenario.assumptions, live);

    /* 3. 二次确认窗口：取锁后再次比对，防止排队期间生产状态被改 */
    const recheck = snapshotProduction();
    if (recheck.version !== scenario.baseVersion) {
      scenario.status = 'stale';
      throw new ScenarioError(409, 'VERSION_CONFLICT', '提交排队期间生产状态发生变化，请刷新后重试',
        { baseVersion: scenario.baseVersion, currentVersion: recheck.version, changedEntities: diffSnapshot(scenario.snapshot, recheck) });
    }

    /* 4. 应用差异到生产状态 */
    const diff: AppliedDiffEntry[] = [];
    const a = scenario.assumptions;

    const liveVoyage = voyages.find(v => v.id === a.voyageId)!;
    const voyageChanges = diffEntry(
      { eta: liveVoyage.eta, etd: liveVoyage.etd } as Record<string, unknown>,
      { eta: a.eta ?? liveVoyage.eta, etd: a.etd ?? liveVoyage.etd } as Record<string, unknown>
    );
    if (Object.keys(voyageChanges).length) {
      Object.assign(liveVoyage, Object.fromEntries(Object.entries(voyageChanges).map(([k, v]) => [k, v.to])));
      diff.push({ entity: 'voyage', id: liveVoyage.id, action: 'update', changes: voyageChanges, basis: 'assumption' });
    }

    const etaTime = new Date(a.eta ?? liveVoyage.eta).getTime();
    for (const containerId of a.earlyLoadContainerIds) {
      const container = containers.find(c => c.id === containerId)!;
      const taskId = `TASK-${Date.now()}-${containerId.slice(-4)}`;
      const payload: YardTask = {
        id: taskId, kind: 'load', containerId, from: container.yardSlot, to: `${liveVoyage.berth} / ${liveVoyage.id}`,
        equipmentId: equipment.find(e => e.kind === 'quay-crane' && e.status !== 'maintenance')?.id,
        priority: 90, status: 'queued', scheduledAt: new Date(etaTime + 30 * 60000).toISOString(),
        blockingReasons: [], estimatedMinutes: 8,
      };
      tasks.push(payload);
      diff.push({ entity: 'task', id: taskId, action: 'create', payload: payload as unknown as Record<string, unknown>, basis: 'assumption' });
    }

    for (const reloc of a.relocations) {
      const container = containers.find(c => c.id === reloc.containerId)!;
      const target = blocks.find(b => b.id === reloc.toBlockId)!;
      const beforeSlot = container.yardSlot;
      const toSlot = `${reloc.toBlockId}-R${String(target.rows).padStart(2, '0')}-T1`;
      container.yardSlot = toSlot;
      container.lastEvent = `方案 ${scenario.id} 移箱 ${new Date().toLocaleString()}`;
      diff.push({
        entity: 'container', id: container.id, action: 'update',
        changes: { yardSlot: { from: beforeSlot, to: toSlot } }, basis: 'assumption',
      });
      const taskId = `TASK-${Date.now()}-R${reloc.toBlockId}`;
      const payload: YardTask = {
        id: taskId, kind: 'rehandle', containerId: container.id, from: beforeSlot, to: toSlot,
        equipmentId: target.equipment.includes('reach-stacker')
          ? equipment.find(e => e.kind === 'reach-stacker' && e.status !== 'maintenance' && e.status !== 'offline')?.id
          : equipment.find(e => e.kind === 'yard-crane' && e.status !== 'maintenance' && e.status !== 'offline')?.id,
        priority: 85, status: 'queued', scheduledAt: new Date(etaTime + 15 * 60000).toISOString(),
        blockingReasons: [], estimatedMinutes: 12,
      };
      tasks.push(payload);
      diff.push({ entity: 'task', id: taskId, action: 'create', payload: payload as unknown as Record<string, unknown>, basis: 'assumption' });
    }

    for (const override of a.equipmentOverrides) {
      const machine = equipment.find(e => e.id === override.equipmentId)!;
      const before = { movesPerHour: machine.movesPerHour, status: machine.status } as Record<string, unknown>;
      if (override.movesPerHour !== undefined) machine.movesPerHour = override.movesPerHour;
      if (override.status) machine.status = override.status;
      const after = { movesPerHour: machine.movesPerHour, status: machine.status } as Record<string, unknown>;
      const changes = diffEntry(before, after);
      if (Object.keys(changes).length) diff.push({ entity: 'equipment', id: machine.id, action: 'update', changes, basis: 'assumption' });
    }

    for (const override of a.capacityOverrides) {
      const block = blocks.find(b => b.id === override.blockId)!;
      const before = { capacity: block.capacity, occupied: block.occupied } as Record<string, unknown>;
      if (override.capacity !== undefined) block.capacity = override.capacity;
      if (override.occupied !== undefined) block.occupied = override.occupied;
      const after = { capacity: block.capacity, occupied: block.occupied } as Record<string, unknown>;
      const changes = diffEntry(before, after);
      if (Object.keys(changes).length) diff.push({ entity: 'block', id: block.id, action: 'update', changes, basis: 'assumption' });
    }

    /* 5. 版本递增 + 审计 + 标记已提交 */
    const version = bumpProductionVersion();
    scenario.status = 'committed';
    scenario.commit = { committedAt: new Date().toISOString(), version, diff };
    recordAudit('SCENARIO_COMMIT', 'scenario', scenario.id,
      `方案差异提交生产：${diff.length} 项变更（航时 ${a.eta || a.etd ? 1 : 0}、提前装船 ${a.earlyLoadContainerIds.length} 箱、移箱 ${a.relocations.length} 箱），提交后版本 v${version}`);
    auditEvents.unshift({ id: `AUD-${Date.now()}-scn`, actor, action: 'SCENARIO_APPLY', entity: 'voyage', entityId: a.voyageId, at: new Date().toISOString(), details: JSON.stringify(diff) });
    return { id: scenario.id, version, diff };
  });
}
