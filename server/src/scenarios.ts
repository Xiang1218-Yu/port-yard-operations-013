import { blocks, containers, equipment, recordAudit, snapshotProduction, tasks, voyages, type ProductionSnapshot } from './domain.js';
import type { Container, Equipment, YardBlock, YardTask } from './domain.js';

/*
 * 航次作业情景推演（What-if Scenario Studio）
 *
 * 隔离原则：方案创建时对当前内存生产状态做深拷贝（workspace snapshot），
 * 之后所有调整（ETA/ETD、目标箱集、设备能力、区块容量）与推演计算都只作用于副本，
 * 生产数组（voyages/containers/blocks/equipment/tasks）在方案提交前不会被触碰。
 *
 * 并发控制：
 * - productionRevision：任何生产写入都会使全局版本号 +1；
 * - baseSignatures：方案创建时记录受影响实体的内容签名；
 * - 提交时同时校验 revision 与签名——revision 变化但与本方案不相交的变更不拦截，
 *   相交字段被改动则返回 409 CONFLICT 及当前生产值；
 * - commitLock 串行化两个方案的并发提交，保证后到的方案能看到先到方案的写入。
 */

export type RiskLevel = 'low' | 'medium' | 'high';
export type Basis = 'production-fact' | 'assumption';
export type ScenarioStatus = 'draft' | 'computing' | 'computed' | 'interrupted' | 'committed' | 'expired' | 'discarded';
export type ComputeStatus = 'ready' | 'interrupted';

export interface RelocationInput { containerId: string; targetBlockId: string; }
export interface EquipmentOverrideInput { equipmentId: string; movesPerHour?: number; movesPerHourDelta?: number; available?: boolean; }
export interface BlockCapacityOverrideInput { blockId: string; capacity?: number; capacityDelta?: number; }
export interface ScenarioAdjustments {
  eta?: string;
  etd?: string;
  earlyLoadContainerIds?: string[];
  relocations?: RelocationInput[];
  equipmentOverrides?: EquipmentOverrideInput[];
  blockCapacityOverrides?: BlockCapacityOverrideInput[];
}

export interface ScenarioRisk { severity: RiskLevel; code: string; message: string; basis: Basis; }
export interface ScenarioAssumption { id: string; label: string; detail: string; }
export interface ScenarioMetric { key: string; label: string; production: number; projected: number; delta: number; unit: string; basis: Basis; }
export interface AffectedTask { taskId?: string; containerId: string; kind: YardTask['kind']; change: 'reschedule-early' | 'new-early-load' | 'relocate' | 'rehandle-created' | 'blocked' | 'capability-change'; detail: string; from?: string; to?: string; scheduledAt: string; estimatedMinutes: number; basis: Basis; }
export interface BlockImpact { blockId: string; zone: string; occupied: number; productionOccupied: number; capacity: number; productionCapacity: number; utilization: number; deltaOccupancy: number; capacityChanged: boolean; feasible: boolean; basis: Basis; note?: string; }
export interface WorkloadBand { requiredMinutes: number; effectiveMinutes: number; slackMinutes: number; rateMovesPerHour: number; feasible: boolean; }
export interface ScenarioDiff {
  voyage?: { id: string; patch: { eta?: string; etd?: string } };
  earlyLoads: { containerId: string; taskId?: string; from: string; to: string; scheduledAt: string }[];
  relocations: { containerId: string; taskId?: string; from: string; to: string; targetBlockId: string; scheduledAt: string }[];
  equipmentOverrides: { equipmentId: string; patch: { movesPerHour: number } }[];
  blockCapacityOverrides: { blockId: string; patch: { capacity: number } }[];
}

export interface ScenarioResult {
  status: ComputeStatus;
  computedAt: string;
  interruptedAt?: string;
  progress?: string;
  basisNotes: { label: string; detail: string }[];
  assumptions: ScenarioAssumption[];
  remainingMoves: { production: number; projected: number; delta: number };
  window: { eta: string; etd: string; productionEta: string; productionEtd: string; windowMinutes: number; productionWindowMinutes: number; changed: boolean };
  workload: { quay: WorkloadBand; yard: WorkloadBand; truck: WorkloadBand; earlyLeadMinutes: number; earlyLeadFeasible: boolean };
  overallRisk: RiskLevel;
  risks: ScenarioRisk[];
  affectedTasks: AffectedTask[];
  blockImpacts: BlockImpact[];
  metrics: ScenarioMetric[];
  stats: { earlyLoads: number; relocations: number; rejectedEarlyLoads: number; rejectedRelocations: number; affectedTaskCount: number };
  diff: ScenarioDiff;
}

export interface CommitConflict {
  code: 'CONFLICT_PRODUCTION_CHANGED' | 'CONFLICT_SCENARIO_OVERLAP' | 'CONFLICT_ALREADY_COMPLETED' | 'CONFLICT_CAPACITY' | 'SCENARIO_EXPIRED';
  entity: string;
  entityId: string;
  message: string;
  productionValue?: string;
  scenarioValue?: string;
  competingScenarioId?: string;
}
export interface CommitConflictReport { baseRevision: number; currentRevision: number; conflicts: CommitConflict[]; }

export class ScenarioError extends Error {
  status: number;
  code: string;
  report?: CommitConflictReport;
  constructor(status: number, code: string, message: string, report?: CommitConflictReport) { super(message); this.status = status; this.code = code; this.report = report; }
}

export interface Scenario {
  id: string;
  name: string;
  voyageId: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  baseRevision: number;
  baseSignatures: Record<string, string>;
  snapshot: ProductionSnapshot;
  adjustments: ScenarioAdjustments;
  status: ScenarioStatus;
  result?: ScenarioResult;
  computing: boolean;
  cancelRequested: boolean;
  computeToken: number;
  computePromise?: Promise<void>;
  committedAt?: string;
  commitError?: CommitConflictReport;
}

/* ---------------- 生产版本（乐观并发控制） ---------------- */

let productionRevision = 1;
let scenarioTtlMs = 30 * 60 * 1000;
const scenarios = new Map<string, Scenario>();
let scenarioSeq = 0;
let commitQueue: Promise<unknown> = Promise.resolve();

export function bumpProductionRevision() { productionRevision += 1; }
export function currentProductionRevision() { return productionRevision; }
export function _configureScenarioTtl(ms: number) { scenarioTtlMs = ms; }
export function _resetScenarioStore() { scenarios.clear(); scenarioSeq = 0; productionRevision = 1; }

function withCommitLock<T>(fn: () => T): Promise<T> {
  const run = commitQueue.then(() => fn());
  commitQueue = run.then(() => undefined, () => undefined);
  return run;
}

/* ---------------- 实体内容签名 ---------------- */

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${stable(obj[key])}`).join(',')}}`;
}
const signatureKey = (kind: string, id: string) => `${kind}:${id}`;

function captureSignatures(snap: ProductionSnapshot): Record<string, string> {
  const out: Record<string, string> = {};
  snap.voyages.forEach(v => { out[signatureKey('voyage', v.id)] = stable(v); });
  snap.containers.forEach(c => { out[signatureKey('container', c.id)] = stable(c); });
  snap.blocks.forEach(b => { out[signatureKey('block', b.id)] = stable(b); });
  snap.equipment.forEach(e => { out[signatureKey('equipment', e.id)] = stable(e); });
  snap.tasks.forEach(t => { out[signatureKey('task', t.id)] = stable(t); });
  return out;
}

/* ---------------- 方案生命周期 ---------------- */

export interface CreateScenarioInput { name: string; voyageId: string; createdBy?: string; adjustments?: ScenarioAdjustments; }

export function createScenario(input: CreateScenarioInput): ScenarioView {
  const voyage = voyages.find(v => v.id === input.voyageId);
  if (!voyage) throw new ScenarioError(404, 'VOYAGE_NOT_FOUND', `航次 ${input.voyageId} 不存在`);
  if (voyage.status === 'departed') throw new ScenarioError(409, 'VOYAGE_DEPARTED', `航次 ${input.voyageId} 已离港，不能再推演`);
  const snapshot = snapshotProduction();
  const adjustments = input.adjustments ?? {};
  validateAdjustments(adjustments, snapshot);
  scenarioSeq += 1;
  const now = Date.now();
  const scenario: Scenario = {
    id: `SCN-${String(scenarioSeq).padStart(3, '0')}`,
    name: input.name?.trim() || `推演方案 ${scenarioSeq}`,
    voyageId: input.voyageId,
    createdBy: input.createdBy || '中控调度员',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + scenarioTtlMs).toISOString(),
    baseRevision: productionRevision,
    baseSignatures: captureSignatures(snapshot),
    snapshot,
    adjustments,
    status: 'draft',
    computing: false,
    cancelRequested: false,
    computeToken: 0
  };
  scenarios.set(scenario.id, scenario);
  recordAudit('SCENARIO_CREATE', 'scenario', scenario.id, `基于生产版本 r${productionRevision} 创建隔离推演「${scenario.name}」（航次 ${input.voyageId}）`);
  return toClient(scenario);
}

export function scenarioRuntimeState() { return { revision: productionRevision, scenarioCount: scenarios.size, now: new Date().toISOString() }; }
export function listScenarios(): ScenarioView[] { return [...scenarios.values()].map(lazyExpire).map(toClient); }
export function getScenario(id: string): ScenarioView { return toClient(lazyExpire(requireScenario(id))); }
export function deleteScenario(id: string) { const scenario = lazyExpire(requireScenario(id)); scenario.status = 'discarded'; scenarios.delete(id); recordAudit('SCENARIO_DISCARD', 'scenario', id, '放弃推演方案，未对生产状态产生任何写入'); return { deleted: true, id }; }

function requireScenario(id: string): Scenario {
  const scenario = scenarios.get(id);
  if (!scenario) throw new ScenarioError(404, 'SCENARIO_NOT_FOUND', `推演方案 ${id} 不存在或已被清理`);
  return scenario;
}
function lazyExpire(scenario: Scenario): Scenario {
  if (!['committed', 'discarded', 'expired'].includes(scenario.status) && Date.now() > new Date(scenario.expiresAt).getTime()) {
    scenario.status = 'expired';
    scenario.computing = false;
  }
  return scenario;
}

export function updateScenarioAdjustments(id: string, patch: ScenarioAdjustments): ScenarioView {
  const scenario = lazyExpire(requireScenario(id));
  if (scenario.computing) throw new ScenarioError(409, 'COMPUTE_RUNNING', '推演计算进行中，暂不能修改假设；如需中断请先取消计算');
  if (scenario.status === 'committed') throw new ScenarioError(409, 'SCENARIO_COMMITTED', '方案已提交，不能再修改');
  if (scenario.status === 'expired') throw new ScenarioError(410, 'SCENARIO_EXPIRED', '方案已过期，请先重建基线（rebase）');
  const merged: ScenarioAdjustments = {
    eta: patch.eta !== undefined ? patch.eta : scenario.adjustments.eta,
    etd: patch.etd !== undefined ? patch.etd : scenario.adjustments.etd,
    earlyLoadContainerIds: patch.earlyLoadContainerIds ?? scenario.adjustments.earlyLoadContainerIds,
    relocations: patch.relocations ?? scenario.adjustments.relocations,
    equipmentOverrides: mergeEquipment(scenario.adjustments.equipmentOverrides, patch.equipmentOverrides),
    blockCapacityOverrides: mergeBlockCapacity(scenario.adjustments.blockCapacityOverrides, patch.blockCapacityOverrides)
  };
  validateAdjustments(merged, scenario.snapshot);
  scenario.adjustments = merged;
  scenario.result = undefined;
  scenario.status = 'draft';
  return toClient(scenario);
}
function mergeEquipment(base: EquipmentOverrideInput[] | undefined, incoming: EquipmentOverrideInput[] | undefined): EquipmentOverrideInput[] {
  const map = new Map<string, EquipmentOverrideInput>((base ?? []).map(item => [item.equipmentId, item]));
  (incoming ?? []).forEach(item => map.set(item.equipmentId, { ...map.get(item.equipmentId), ...item }));
  return [...map.values()];
}
function mergeBlockCapacity(base: BlockCapacityOverrideInput[] | undefined, incoming: BlockCapacityOverrideInput[] | undefined): BlockCapacityOverrideInput[] {
  const map = new Map<string, BlockCapacityOverrideInput>((base ?? []).map(item => [item.blockId, item]));
  (incoming ?? []).forEach(item => map.set(item.blockId, { ...map.get(item.blockId), ...item }));
  return [...map.values()];
}

function validateAdjustments(adj: ScenarioAdjustments, snap: ProductionSnapshot) {
  if (adj.eta && Number.isNaN(new Date(adj.eta).getTime())) throw new ScenarioError(400, 'INVALID_ETA', 'ETA 不是合法时间');
  if (adj.etd && Number.isNaN(new Date(adj.etd).getTime())) throw new ScenarioError(400, 'INVALID_ETD', 'ETD 不是合法时间');
  if (adj.eta && adj.etd && new Date(adj.etd) <= new Date(adj.eta)) throw new ScenarioError(400, 'INVALID_WINDOW', 'ETD 必须晚于 ETA，靠泊窗口不能为零或倒置');
  const unknownContainer = (adj.earlyLoadContainerIds ?? []).find(id => !snap.containers.some(c => c.id === id));
  if (unknownContainer) throw new ScenarioError(400, 'CONTAINER_NOT_FOUND', `目标箱 ${unknownContainer} 在基线生产状态中不存在`);
  for (const relocation of adj.relocations ?? []) {
    if (!snap.containers.some(c => c.id === relocation.containerId)) throw new ScenarioError(400, 'CONTAINER_NOT_FOUND', `移箱目标 ${relocation.containerId} 不存在`);
    if (!snap.blocks.some(b => b.id === relocation.targetBlockId)) throw new ScenarioError(400, 'BLOCK_NOT_FOUND', `目标区块 ${relocation.targetBlockId} 不存在`);
  }
  for (const override of adj.equipmentOverrides ?? []) {
    if (!snap.equipment.some(e => e.id === override.equipmentId)) throw new ScenarioError(400, 'EQUIPMENT_NOT_FOUND', `设备 ${override.equipmentId} 不存在`);
    if (override.movesPerHour !== undefined && override.movesPerHour < 0) throw new ScenarioError(400, 'INVALID_RATE', '设备作业能力不能为负数');
  }
  for (const override of adj.blockCapacityOverrides ?? []) {
    if (!snap.blocks.some(b => b.id === override.blockId)) throw new ScenarioError(400, 'BLOCK_NOT_FOUND', `区块 ${override.blockId} 不存在`);
    const target = snap.blocks.find(b => b.id === override.blockId)!;
    const capacity = override.capacity ?? target.capacity + (override.capacityDelta ?? 0);
    if (capacity < 0 || !Number.isFinite(capacity)) throw new ScenarioError(400, 'INVALID_CAPACITY', '区块容量必须为非负数');
  }
}

/* ---------------- 推演引擎 ---------------- */

interface Workspace { snap: ProductionSnapshot; voyage: (typeof voyages)[number]; eta: Date; etd: Date; equipmentById: Map<string, Equipment & { assumedRate?: number; assumedOffline?: boolean }>; blocksById: Map<string, YardBlock & { assumedCapacity?: number }>; simulatedOccupied: Map<string, number>; simulatedUsedPlugs: Map<string, number>; }

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const INTERRUPT = Symbol('scenario-compute-interrupted');
const parseBlock = (slot: string) => slot.match(/^([A-Z]\d\d)-/)?.[1];

export interface ComputeOptions { stepDelayMs?: number; }

export function startScenarioCompute(id: string, options: ComputeOptions = {}): ScenarioView {
  const scenario = lazyExpire(requireScenario(id));
  if (scenario.status === 'expired') throw new ScenarioError(410, 'SCENARIO_EXPIRED', '方案已过期，请先重建基线（rebase）');
  if (scenario.status === 'committed') throw new ScenarioError(409, 'SCENARIO_COMMITTED', '方案已提交，不能重新推演');
  if (scenario.computing) throw new ScenarioError(409, 'COMPUTE_RUNNING', '该方案已有推演计算在运行');
  scenario.computing = true;
  scenario.cancelRequested = false;
  scenario.computeToken += 1;
  scenario.status = 'computing';
  scenario.computePromise = runCompute(scenario, options).catch(error => { if (error !== INTERRUPT) throw error; });
  return toClient(scenario);
}
export async function awaitScenarioCompute(id: string) {
  const scenario = requireScenario(id);
  if (scenario.computePromise) await scenario.computePromise;
  return toClient(lazyExpire(scenario));
}
export function cancelScenarioCompute(id: string): ScenarioView {
  const scenario = requireScenario(id);
  if (!scenario.computing) throw new ScenarioError(409, 'COMPUTE_NOT_RUNNING', '该方案当前没有进行中的推演计算');
  scenario.cancelRequested = true;
  return toClient(scenario);
}

async function runCompute(scenario: Scenario, options: ComputeOptions): Promise<void> {
  const stepDelay = options.stepDelayMs ?? 0;
  const token = scenario.computeToken;
  const checkpoint = async (phase: string) => {
    if (stepDelay) await sleep(stepDelay);
    const current = scenarios.get(scenario.id);
    if (!current || current.cancelRequested || current.computeToken !== token) {
      const partial = current?.result;
      if (current) {
        current.result = { ...(partial ?? emptyResult(scenario)), status: 'interrupted', interruptedAt: new Date().toISOString(), progress: phase };
        current.computing = false;
        current.status = 'interrupted';
      }
      throw INTERRUPT;
    }
    if (current.result && current.result.status !== 'interrupted') current.result.progress = phase;
  };

  try {
    const result = await evaluate(scenario, () => checkpoint('推演阶段推进中'));
    scenario.result = result;
    scenario.status = 'computed';
    scenario.computing = false;
    scenario.cancelRequested = false;
  } catch (error) {
    if (error === INTERRUPT) return;
    scenario.computing = false;
    scenario.status = 'draft';
    scenario.cancelRequested = false;
    throw error;
  }
}

function emptyResult(scenario: Scenario): ScenarioResult {
  return { status: 'ready', computedAt: new Date().toISOString(), basisNotes: [], assumptions: [], remainingMoves: { production: 0, projected: 0, delta: 0 }, window: { eta: '', etd: '', productionEta: '', productionEtd: '', windowMinutes: 0, productionWindowMinutes: 0, changed: false }, workload: { quay: band(0, 0, 0), yard: band(0, 0, 0), truck: band(0, 0, 0), earlyLeadMinutes: 0, earlyLeadFeasible: true }, overallRisk: 'low', risks: [], affectedTasks: [], blockImpacts: [], metrics: [], stats: { earlyLoads: 0, relocations: 0, rejectedEarlyLoads: 0, rejectedRelocations: 0, affectedTaskCount: 0 }, diff: { earlyLoads: [], relocations: [], equipmentOverrides: [], blockCapacityOverrides: [] } };
}
function band(required: number, effective: number, rate: number): WorkloadBand { return { requiredMinutes: Math.round(required), effectiveMinutes: Math.round(effective), slackMinutes: Math.round(effective - required), rateMovesPerHour: rate, feasible: effective >= required }; }

async function evaluate(scenario: Scenario, checkpoint: () => Promise<void>): Promise<ScenarioResult> {
  const adj = scenario.adjustments;
  const workspace = buildWorkspace(scenario);
  const risks: ScenarioRisk[] = [];
  const affectedTasks: AffectedTask[] = [];
  const assumptions: ScenarioAssumption[] = [];
  const diff: ScenarioDiff = { earlyLoads: [], relocations: [], equipmentOverrides: [], blockCapacityOverrides: [] };

  /* 1) 窗口假设 */
  if (adj.eta || adj.etd) {
    diff.voyage = { id: scenario.voyageId, patch: { ...(adj.eta ? { eta: workspace.eta.toISOString() } : {}), ...(adj.etd ? { etd: workspace.etd.toISOString() } : {}) } };
    assumptions.push({ id: 'window', label: '靠泊窗口假设', detail: `ETA ${fmt(workspace.eta)} / ETD ${fmt(workspace.etd)}（非生产数据，仅用于本方案）` });
  }

  /* 2) 设备能力假设 */
  for (const override of adj.equipmentOverrides ?? []) {
    const machine = workspace.equipmentById.get(override.equipmentId)!;
    const productionRate = machine.movesPerHour;
    const nextRate = override.movesPerHour ?? productionRate + (override.movesPerHourDelta ?? 0);
    machine.assumedRate = nextRate;
    if (override.available === false) machine.assumedOffline = true;
    diff.equipmentOverrides.push({ equipmentId: machine.id, patch: { movesPerHour: nextRate } });
    assumptions.push({ id: `equipment-${machine.id}`, label: '设备能力假设', detail: `${machine.name}：${override.available === false ? '推演中停用' : `作业能力 ${productionRate} → ${nextRate} moves/h`}（生产实测仍为 ${productionRate}）` });
  }

  /* 3) 区块容量假设 */
  for (const override of adj.blockCapacityOverrides ?? []) {
    const block = workspace.blocksById.get(override.blockId)!;
    const nextCapacity = override.capacity ?? block.capacity + (override.capacityDelta ?? 0);
    block.assumedCapacity = nextCapacity;
    diff.blockCapacityOverrides.push({ blockId: block.id, patch: { capacity: nextCapacity } });
    assumptions.push({ id: `capacity-${block.id}`, label: '区块容量假设', detail: `${block.id} 容量 ${block.capacity} → ${nextCapacity}（当前生产容量仍为 ${block.capacity}）` });
    if (nextCapacity < block.occupied) risks.push({ severity: 'high', code: 'ASSUMED_CAPACITY_BELOW_OCCUPIED', message: `${block.id} 假设容量 ${nextCapacity} 小于当前占用 ${block.occupied}，假设本身不可行`, basis: 'assumption' });
  }

  await checkpoint();

  /* 4) 生产事实风险（来自基线快照，不因假设改变） */
  const voyageContainers = new Set(workspace.snap.containers.filter(c => c.voyageId === scenario.voyageId).map(c => c.id));
  if (workspace.voyage.lateRisk === 'high') risks.push({ severity: 'medium', code: 'PRODUCTION_LATE_RISK', message: `生产状态中 ${workspace.voyage.vessel} 已标记 HIGH 延误风险`, basis: 'production-fact' });
  workspace.snap.tasks.filter(t => t.status === 'blocked' && voyageContainers.has(t.containerId)).forEach(t => risks.push({ severity: 'high', code: 'PRODUCTION_BLOCKED_TASK', message: `任务 ${t.id}（箱 ${t.containerId}）在生产中处于阻塞：${t.blockingReasons.join('；') || '未注明'}`, basis: 'production-fact' }));
  workspace.snap.equipment.filter(e => (e.kind === 'quay-crane' || e.kind === 'yard-crane' || e.kind === 'reach-stacker') && (e.status === 'maintenance' || e.status === 'offline')).forEach(e => risks.push({ severity: 'medium', code: 'PRODUCTION_EQUIPMENT_DOWN', message: `${e.name} 在生产中为 ${e.status === 'maintenance' ? '维护中' : '离线'}`, basis: 'production-fact' }));

  /* 5) 提前装船（early load）——对隔离副本计算，不触碰生产任务 */
  let rejectedEarly = 0;
  for (const containerId of adj.earlyLoadContainerIds ?? []) {
    const container = workspace.snap.containers.find(c => c.id === containerId)!;
    const completed = isContainerWorkComplete(container, workspace.snap.tasks);
    if (completed) { rejectedEarly += 1; risks.push({ severity: 'high', code: 'EARLY_TARGET_COMPLETED', message: `箱 ${containerId} 的装船作业在基线中已完成，提前装船无意义`, basis: 'production-fact' }); await checkpoint(); continue; }
    if (container.voyageId !== scenario.voyageId) { rejectedEarly += 1; risks.push({ severity: 'high', code: 'EARLY_TARGET_WRONG_VOYAGE', message: `箱 ${containerId} 不属于航次 ${scenario.voyageId}`, basis: 'production-fact' }); await checkpoint(); continue; }
    if (container.direction === 'import') { rejectedEarly += 1; risks.push({ severity: 'medium', code: 'EARLY_TARGET_IMPORT', message: `箱 ${containerId} 是进口箱，不能提前装船`, basis: 'production-fact' }); await checkpoint(); continue; }
    if (container.customs !== 'released') { rejectedEarly += 1; risks.push({ severity: 'high', code: 'CUSTOMS_NOT_RELEASED', message: `箱 ${containerId} 海关状态为 ${container.customs}，提前装船会被监管拦截`, basis: 'production-fact' }); await checkpoint(); continue; }
    const existing = openTaskFor(workspace.snap.tasks, containerId, 'load');
    const scheduledAt = workspace.eta.toISOString();
    affectedTasks.push(existing
      ? { taskId: existing.id, containerId, kind: 'load', change: 'reschedule-early', detail: `装船任务由 ${fmt(new Date(existing.scheduledAt))} 提前至 ${fmt(workspace.eta)}（假设窗口）`, from: existing.from, to: existing.to, scheduledAt, estimatedMinutes: existing.estimatedMinutes, basis: 'assumption' }
      : { containerId, kind: 'load', change: 'new-early-load', detail: `新增提前装船：${container.yardSlot} → ${workspace.voyage.berth} / ${scenario.voyageId}`, from: container.yardSlot, to: `${workspace.voyage.berth} / ${scenario.voyageId}`, scheduledAt, estimatedMinutes: 14, basis: 'assumption' });
    diff.earlyLoads.push({ containerId, taskId: existing?.id, from: existing?.from ?? container.yardSlot, to: existing?.to ?? `${workspace.voyage.berth} / ${scenario.voyageId}`, scheduledAt });
    await checkpoint();
  }
  if (diff.earlyLoads.length) assumptions.push({ id: 'early-load', label: '目标箱集假设 · 提前装船', detail: `${diff.earlyLoads.length} 个箱计划在假设 ETA 时点提前装船（${rejectedEarly} 个目标被否决）` });

  /* 6) 移到更近区块（relocation）——含危险品/冷藏/容量约束 */
  const rehandleAt = new Date(workspace.eta.getTime() + 15 * 60000);
  let rejectedRelocations = 0;
  for (const relocation of adj.relocations ?? []) {
    const container = workspace.snap.containers.find(c => c.id === relocation.containerId)!;
    const target = workspace.blocksById.get(relocation.targetBlockId)!;
    const fromBlockId = parseBlock(container.yardSlot);
    if (isContainerWorkComplete(container, workspace.snap.tasks)) { rejectedRelocations += 1; risks.push({ severity: 'high', code: 'RELOCATION_TARGET_COMPLETED', message: `箱 ${container.id} 作业已完成，移箱方案对其无效`, basis: 'production-fact' }); await checkpoint(); continue; }
    if (container.hazmatClass && !target.hazmatAllowed) { rejectedRelocations += 1; risks.push({ severity: 'high', code: 'HAZMAT_BLOCK_REJECT', message: `${target.id} 无危险品隔离资质，${container.id}（${container.hazmatClass} 类）不能移入`, basis: 'assumption' }); await checkpoint(); continue; }
    if (container.reefer && target.reeferPlugs - workspace.simulatedUsedPlugs.get(target.id)! <= 0) { rejectedRelocations += 1; risks.push({ severity: 'high', code: 'REEFER_PLUG_SHORTFALL', message: `${target.id} 推演占用后无剩余冷藏插座，${container.id} 无法接入电源`, basis: 'assumption' }); await checkpoint(); continue; }
    if (workspace.simulatedOccupied.get(target.id)! >= (target.assumedCapacity ?? target.capacity)) { rejectedRelocations += 1; risks.push({ severity: 'high', code: 'CAPACITY_SHORTFALL', message: `${target.id} 在推演占用下达到 ${workspace.simulatedOccupied.get(target.id)!}/${target.assumedCapacity ?? target.capacity}，${container.id} 移入将超出容量`, basis: 'assumption' }); await checkpoint(); continue; }
    if (fromBlockId) workspace.simulatedOccupied.set(fromBlockId, workspace.simulatedOccupied.get(fromBlockId)! - 1);
    workspace.simulatedOccupied.set(target.id, workspace.simulatedOccupied.get(target.id)! + 1);
    if (container.reefer) { if (fromBlockId) workspace.simulatedUsedPlugs.set(fromBlockId, workspace.simulatedUsedPlugs.get(fromBlockId)! - 1); workspace.simulatedUsedPlugs.set(target.id, workspace.simulatedUsedPlugs.get(target.id)! + 1); }
    const newSlot = nextFreeSlot(target, workspace.snap, relocation.containerId);
    const existing = openTaskFor(workspace.snap.tasks, container.id, 'rehandle');
    affectedTasks.push(existing
      ? { taskId: existing.id, containerId: container.id, kind: 'rehandle', change: 'relocate', detail: `翻箱任务改向：${fromBlockId ?? container.yardSlot} → ${target.id}（更近区块假设）`, from: existing.from, to: newSlot, scheduledAt: rehandleAt.toISOString(), estimatedMinutes: existing.estimatedMinutes, basis: 'assumption' }
      : { containerId: container.id, kind: 'rehandle', change: 'rehandle-created', detail: `新增移箱：${container.yardSlot} → ${newSlot}`, from: container.yardSlot, to: newSlot, scheduledAt: rehandleAt.toISOString(), estimatedMinutes: 26, basis: 'assumption' });
    diff.relocations.push({ containerId: container.id, taskId: existing?.id, from: existing?.from ?? container.yardSlot, to: newSlot, targetBlockId: target.id, scheduledAt: rehandleAt.toISOString() });
    await checkpoint();
  }
  if (diff.relocations.length) assumptions.push({ id: 'relocation', label: '目标箱集假设 · 近区块移箱', detail: `${diff.relocations.length} 个箱移入更近区块（${rejectedRelocations} 个因约束被否决）` });

  /* 7) 设备能力变化影响的在途任务 */
  for (const override of adj.equipmentOverrides ?? []) {
    const machine = workspace.equipmentById.get(override.equipmentId)!;
    workspace.snap.tasks.filter(t => t.equipmentId === machine.id && t.status !== 'done').forEach(t => affectedTasks.push({ taskId: t.id, containerId: t.containerId, kind: t.kind, change: 'capability-change', detail: override.available === false ? `${machine.name} 推演停用，任务需改派设备` : `${machine.name} 能力变为 ${machine.assumedRate} moves/h，任务预计时长随之变化`, scheduledAt: t.scheduledAt, estimatedMinutes: t.estimatedMinutes, basis: 'assumption' }));
  }

  /* 8) 容量推演结果（全部区块，区分事实与假设） */
  const blockImpacts: BlockImpact[] = [...workspace.blocksById.values()].map(block => {
    const capacity = block.assumedCapacity ?? block.capacity;
    const occupied = workspace.simulatedOccupied.get(block.id)!;
    const delta = occupied - block.occupied;
    const capacityChanged = capacity !== block.capacity;
    const touched = capacityChanged || delta !== 0;
    return { blockId: block.id, zone: block.zone, occupied, productionOccupied: block.occupied, capacity, productionCapacity: block.capacity, utilization: occupied / capacity, deltaOccupancy: delta, capacityChanged, feasible: occupied <= capacity, basis: touched ? 'assumption' : 'production-fact', note: capacityChanged ? `容量来自假设（${block.capacity} → ${capacity}）` : undefined };
  });
  blockImpacts.filter(b => !b.feasible).forEach(b => risks.push({ severity: 'high', code: 'BLOCK_OVERFLOW', message: `${b.blockId} 推演后占用 ${b.occupied}/${b.capacity}，超出容量 ${b.occupied - b.capacity} 箱`, basis: 'assumption' }));

  /* 9) 剩余 moves 与窗口设备产能平衡 */
  const productionRemaining = workspace.voyage.movesPlanned - workspace.voyage.movesDone;
  const projectedRemaining = Math.max(0, productionRemaining - diff.earlyLoads.length);
  const windowMinutes = Math.max(0, (workspace.etd.getTime() - workspace.eta.getTime()) / 60000);
  const productionWindowMinutes = Math.max(0, (new Date(workspace.voyage.etd).getTime() - new Date(workspace.voyage.eta).getTime()) / 60000);
  const rate = (ids: Equipment['kind'][], offlineOk = false) => [...workspace.equipmentById.values()].filter(e => ids.includes(e.kind) && (offlineOk || !e.assumedOffline) && e.status !== 'maintenance' && e.status !== 'offline').reduce((sum, e) => sum + (e.assumedRate ?? e.movesPerHour), 0);
  const quayRate = rate(['quay-crane']);
  const yardRate = rate(['yard-crane', 'reach-stacker']);
  const truckRate = rate(['terminal-truck']);
  const queueBacklog = [...workspace.equipmentById.values()].filter(e => ['yard-crane', 'reach-stacker'].includes(e.kind) && !e.assumedOffline).reduce((sum, e) => sum + e.queue, 0);
  const yardMoves = projectedRemaining + diff.relocations.length + Math.round(queueBacklog / 3);
  const quayBand = band((projectedRemaining / Math.max(1, quayRate)) * 60, (quayRate * windowMinutes) / 60, quayRate);
  const yardBand = band((yardMoves / Math.max(1, yardRate)) * 60, (yardRate * windowMinutes) / 60, yardRate);
  const truckBand = band(0, (truckRate * windowMinutes) / 60, truckRate);
  if (!quayBand.feasible) risks.push({ severity: 'high', code: 'QUAY_CAPACITY_GAP', message: `岸桥窗口产能缺口约 ${Math.ceil(-quayBand.slackMinutes)} 分钟，${projectedRemaining} moves 无法在假设窗口内完成`, basis: 'assumption' });
  if (!yardBand.feasible) risks.push({ severity: 'high', code: 'YARD_CAPACITY_GAP', message: `场桥/正面吊窗口产能缺口约 ${Math.ceil(-yardBand.slackMinutes)} 分钟（含 ${diff.relocations.length} 次移箱与积压队列）`, basis: 'assumption' });
  if (truckRate < quayRate) risks.push({ severity: 'medium', code: 'TRUCK_BOTTLENECK', message: `集卡有效能力 ${truckRate} moves/h 低于岸桥 ${quayRate} moves/h，水平运输可能成为瓶颈`, basis: (adj.equipmentOverrides ?? []).some(o => workspace.equipmentById.get(o.equipmentId)?.kind === 'terminal-truck') ? 'assumption' : 'production-fact' });

  /* 10) 提前装船的提前期可行性（现在 → 假设 ETA） */
  const leadMinutes = Math.max(0, (workspace.eta.getTime() - Date.now()) / 60000);
  const earlyLeadFeasible = diff.earlyLoads.length === 0 || (quayRate * leadMinutes / 60 >= diff.earlyLoads.length && yardRate * leadMinutes / 60 >= diff.earlyLoads.length);
  if (!earlyLeadFeasible) risks.push({ severity: 'high', code: 'EARLY_LEAD_TOO_SHORT', message: `距假设 ETA 仅 ${Math.round(leadMinutes)} 分钟，岸桥/场桥提前期不足以完成 ${diff.earlyLoads.length} 个提前装船`, basis: 'assumption' });

  /* 11) 生产基线窗口是否本身已紧张（事实结论，独立于假设） */
  const productionQuayRate = workspace.snap.equipment.filter(e => e.kind === 'quay-crane' && e.status !== 'maintenance' && e.status !== 'offline').reduce((s, e) => s + e.movesPerHour, 0);
  if ((productionRemaining / Math.max(1, productionQuayRate)) * 60 > productionWindowMinutes) risks.push({ severity: 'high', code: 'PRODUCTION_WINDOW_TIGHT', message: `按生产窗口与当前岸桥能力，${productionRemaining} 剩余 moves 已超出窗口产能`, basis: 'production-fact' });

  const metrics: ScenarioMetric[] = [
    { key: 'remaining', label: '窗口内剩余 moves', production: productionRemaining, projected: projectedRemaining, delta: projectedRemaining - productionRemaining, unit: 'moves', basis: diff.earlyLoads.length ? 'assumption' : 'production-fact' },
    { key: 'rehandle', label: '新增/改向翻箱', production: 0, projected: diff.relocations.length, delta: diff.relocations.length, unit: '次', basis: diff.relocations.length ? 'assumption' : 'production-fact' },
    { key: 'window', label: '靠泊窗口时长', production: Math.round(productionWindowMinutes), projected: Math.round(windowMinutes), delta: Math.round(windowMinutes - productionWindowMinutes), unit: '分钟', basis: diff.voyage ? 'assumption' : 'production-fact' },
    { key: 'quay-slack', label: '岸桥窗口产能余量', production: 0, projected: quayBand.slackMinutes, delta: quayBand.slackMinutes, unit: '分钟', basis: 'assumption' }
  ];

  const severityRank = { high: 3, medium: 2, low: 1 } as const;
  const overallRisk: RiskLevel = risks.some(r => r.severity === 'high') ? 'high' : risks.some(r => r.severity === 'medium') ? 'medium' : 'low';
  if (!assumptions.length) risks.push({ severity: 'low', code: 'NO_ASSUMPTIONS', message: '未设置任何假设调整，推演结果与生产基线一致', basis: 'production-fact' });

  return {
    status: 'ready',
    computedAt: new Date().toISOString(),
    basisNotes: [
      { label: '隔离副本', detail: `基于创建方案时（${scenario.createdAt}）的生产内存快照 r${scenario.baseRevision}，后续生产变更不影响本方案，需通过重建基线获取` },
      { label: '结论来源', detail: '标注「当前生产实测」的结论来自快照中的生产事实；标注「假设推演」的结论仅在本方案假设下成立，提交前不会写入生产' },
      { label: '版本检测', detail: `提交时将比对生产版本（当前基线 r${scenario.baseRevision}）与受影响实体签名，生产变更若与本方案相交会产生版本冲突` }
    ],
    assumptions,
    remainingMoves: { production: productionRemaining, projected: projectedRemaining, delta: projectedRemaining - productionRemaining },
    window: { eta: workspace.eta.toISOString(), etd: workspace.etd.toISOString(), productionEta: workspace.voyage.eta, productionEtd: workspace.voyage.etd, windowMinutes: Math.round(windowMinutes), productionWindowMinutes: Math.round(productionWindowMinutes), changed: Boolean(diff.voyage) },
    workload: { quay: quayBand, yard: yardBand, truck: truckBand, earlyLeadMinutes: Math.round(leadMinutes), earlyLeadFeasible },
    overallRisk,
    risks: risks.sort((a, b) => severityRank[b.severity] - severityRank[a.severity]),
    affectedTasks,
    blockImpacts,
    metrics,
    stats: { earlyLoads: diff.earlyLoads.length, relocations: diff.relocations.length, rejectedEarlyLoads: rejectedEarly, rejectedRelocations, affectedTaskCount: affectedTasks.length },
    diff
  };
}

function buildWorkspace(scenario: Scenario): Workspace {
  const snap: ProductionSnapshot = JSON.parse(JSON.stringify(scenario.snapshot));
  const voyage = snap.voyages.find(v => v.id === scenario.voyageId)!;
  const eta = new Date(scenario.adjustments.eta ?? voyage.eta);
  const etd = new Date(scenario.adjustments.etd ?? voyage.etd);
  const equipmentById = new Map(snap.equipment.map(e => [e.id, e]));
  const blocksById = new Map(snap.blocks.map(b => [b.id, b]));
  return { snap, voyage, eta, etd, equipmentById, blocksById, simulatedOccupied: new Map(snap.blocks.map(b => [b.id, b.occupied])), simulatedUsedPlugs: new Map(snap.blocks.map(b => [b.id, b.usedPlugs])) };
}
function isContainerWorkComplete(container: Container, allTasks: YardTask[]): boolean {
  if (container.status === 'released') return true;
  return allTasks.some(t => t.containerId === container.id && t.kind === 'load' && t.status === 'done');
}
function openTaskFor(allTasks: YardTask[], containerId: string, kind: YardTask['kind']): YardTask | undefined {
  return allTasks.find(t => t.containerId === containerId && t.kind === kind && t.status !== 'done');
}
function nextFreeSlot(block: YardBlock, snap: ProductionSnapshot, containerId: string): string {
  let maxRow = 0;
  for (const c of snap.containers) { const match = c.yardSlot.match(new RegExp(`^${block.id}-R(\\d+)-`)); if (match) maxRow = Math.max(maxRow, Number(match[1])); }
  return `${block.id}-R${String(Math.min(block.rows, maxRow + 1)).padStart(2, '0')}-T1`;
}
function fmt(date: Date) { return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); }

/* ---------------- 提交：差异应用 + 乐观并发校验 ---------------- */

export function commitScenario(id: string): Promise<{ revision: number; applied: ScenarioDiff; scenarioId: string }> {
  const scenario = lazyExpire(requireScenario(id));
  if (scenario.status === 'expired') return Promise.reject(new ScenarioError(410, 'SCENARIO_EXPIRED', '方案已过期，请重建基线后重新推演再提交', { baseRevision: scenario.baseRevision, currentRevision: productionRevision, conflicts: [{ code: 'SCENARIO_EXPIRED', entity: 'scenario', entityId: id, message: `方案在 ${scenario.expiresAt} 过期，期间生产状态可能已大幅变化` }] }));
  if (scenario.computing) return Promise.reject(new ScenarioError(409, 'COMPUTE_RUNNING', '推演计算尚未完成或未中断确认，不能提交'));
  if (scenario.status === 'interrupted') return Promise.reject(new ScenarioError(409, 'COMPUTE_INTERRUPTED', '推演计算被中断，结果不完整，请重新计算或调整假设后再提交'));
  if (scenario.status !== 'computed' || !scenario.result || scenario.result.status !== 'ready') return Promise.reject(new ScenarioError(409, 'RESULT_STALE', '方案参数已变更但尚未重新推演，请先运行计算'));
  const computedResult = scenario.result;

  return withCommitLock(() => {
    const live = snapshotProduction();
    const liveSignatures = captureSignatures(live);
    const touchedKeys = touchedEntityKeys(scenario);
    const conflicts: CommitConflict[] = [];

    /* 1) 版本冲突：生产签名与基线不同且落在本方案影响集合内 */
    if (productionRevision !== scenario.baseRevision) {
      for (const key of touchedKeys) {
        const base = scenario.baseSignatures[key];
        const current = liveSignatures[key];
        if (base === current) continue;
        if (current === undefined) conflicts.push({ code: 'CONFLICT_PRODUCTION_CHANGED', entity: key.split(':')[0], entityId: key.split(':')[1], message: `生产中的 ${key} 已被删除，本方案基线过期`, productionValue: '（已删除）', scenarioValue: base ? '（基线中存在）' : undefined });
        else conflicts.push({ code: 'CONFLICT_PRODUCTION_CHANGED', entity: key.split(':')[0], entityId: key.split(':')[1], message: `${key} 在推演期间被生产作业修改`, productionValue: current.slice(0, 120), scenarioValue: (base ?? '').slice(0, 120) });
      }
    }

    /* 2) 与另一个已提交方案重叠（两个方案同时提交） */
    for (const other of scenarios.values()) {
      if (other.id === scenario.id || other.status !== 'committed' || other.voyageId !== scenario.voyageId || !other.result) continue;
      const overlap = [...touchedKeys].filter(key => committedKeys(other).has(key));
      if (overlap.length) conflicts.push({ code: 'CONFLICT_SCENARIO_OVERLAP', entity: 'scenario', entityId: other.id, competingScenarioId: other.id, message: `方案 ${other.id} 已先提交并改动了重叠实体：${overlap.slice(0, 4).join('、')}${overlap.length > 4 ? ` 等 ${overlap.length} 项` : ''}` });
    }

    /* 3) 箱子已经完成任务（生产在推演期间推进了作业） */
    for (const containerId of [...(scenario.adjustments.earlyLoadContainerIds ?? []), ...(scenario.adjustments.relocations ?? []).map(r => r.containerId)]) {
      const liveContainer = live.containers.find(c => c.id === containerId);
      if (!liveContainer) { conflicts.push({ code: 'CONFLICT_PRODUCTION_CHANGED', entity: 'container', entityId: containerId, message: `箱 ${containerId} 已不在生产台账中` }); continue; }
      if (isContainerWorkComplete(liveContainer, live.tasks)) conflicts.push({ code: 'CONFLICT_ALREADY_COMPLETED', entity: 'container', entityId: containerId, message: `箱 ${containerId} 的装船作业在推演期间已在生产中完成，方案目标失效` });
    }

    /* 4) 容量不足：用当前生产占用重新核算移箱去向 */
    const liveOccupied = new Map(live.blocks.map(b => [b.id, b.occupied]));
    for (const relocation of computedResult.diff.relocations) {
      const container = live.containers.find(c => c.id === relocation.containerId);
      if (!container) continue;
      const fromBlockId = parseBlock(container.yardSlot);
      const cap = live.blocks.find(b => b.id === relocation.targetBlockId)?.capacity ?? 0;
      if (fromBlockId) liveOccupied.set(fromBlockId, liveOccupied.get(fromBlockId)! - 1);
      if (liveOccupied.get(relocation.targetBlockId)! >= cap) conflicts.push({ code: 'CONFLICT_CAPACITY', entity: 'block', entityId: relocation.targetBlockId, message: `按当前生产占用，区块 ${relocation.targetBlockId} 已无法再接收箱 ${relocation.containerId}（占用 ${liveOccupied.get(relocation.targetBlockId)!}/${cap}）` });
      liveOccupied.set(relocation.targetBlockId, liveOccupied.get(relocation.targetBlockId)! + 1);
    }

    if (conflicts.length) {
      scenario.commitError = { baseRevision: scenario.baseRevision, currentRevision: productionRevision, conflicts };
      const error = new ScenarioError(409, 'COMMIT_CONFLICT', `方案提交被拒：检测到 ${conflicts.length} 项冲突，可在重建基线（rebase）后重新推演`, scenario.commitError);
      throw error;
    }

    /* 5) 原子应用差异到生产（同一事件循环 tick 内同步完成） */
    applyDiffToProduction(scenario, computedResult.diff);
    bumpProductionRevision();
    scenario.status = 'committed';
    scenario.committedAt = new Date().toISOString();
    scenario.commitError = undefined;
    recordAudit('SCENARIO_COMMIT', 'scenario', scenario.id, `方案「${scenario.name}」差异提交到生产：窗口 ${computedResult.diff.voyage ? '已改' : '未改'}，提前装船 ${computedResult.diff.earlyLoads.length} 箱，移箱 ${computedResult.diff.relocations.length} 箱，设备 ${computedResult.diff.equipmentOverrides.length} 项，容量 ${computedResult.diff.blockCapacityOverrides.length} 项；r${scenario.baseRevision} → r${productionRevision}`);
    return { revision: productionRevision, applied: computedResult.diff, scenarioId: scenario.id };
  });
}

function touchedEntityKeys(scenario: Scenario): Set<string> {
  const keys = new Set<string>([signatureKey('voyage', scenario.voyageId)]);
  const containerIds = new Set<string>([...(scenario.adjustments.earlyLoadContainerIds ?? []), ...(scenario.adjustments.relocations ?? []).map(r => r.containerId)]);
  containerIds.forEach(id => keys.add(signatureKey('container', id)));
  scenario.snapshot.tasks.filter(t => containerIds.has(t.containerId) && t.status !== 'done').forEach(t => keys.add(signatureKey('task', t.id)));
  (scenario.adjustments.equipmentOverrides ?? []).forEach(o => keys.add(signatureKey('equipment', o.equipmentId)));
  (scenario.adjustments.relocations ?? []).forEach(r => { keys.add(signatureKey('block', r.targetBlockId)); const from = parseBlock(scenario.snapshot.containers.find(c => c.id === r.containerId)?.yardSlot ?? ''); if (from) keys.add(signatureKey('block', from)); });
  (scenario.adjustments.blockCapacityOverrides ?? []).forEach(o => keys.add(signatureKey('block', o.blockId)));
  return keys;
}
function committedKeys(scenario: Scenario): Set<string> {
  const keys = new Set<string>();
  const diff = scenario.result!.diff;
  if (diff.voyage) keys.add(signatureKey('voyage', diff.voyage.id));
  diff.earlyLoads.forEach(item => { keys.add(signatureKey('container', item.containerId)); if (item.taskId) keys.add(signatureKey('task', item.taskId)); keys.add(signatureKey('block', parseBlock(item.from) ?? '-')); });
  diff.relocations.forEach(item => { keys.add(signatureKey('container', item.containerId)); if (item.taskId) keys.add(signatureKey('task', item.taskId)); keys.add(signatureKey('block', item.targetBlockId)); if (parseBlock(item.from)) keys.add(signatureKey('block', parseBlock(item.from)!)); });
  diff.equipmentOverrides.forEach(item => keys.add(signatureKey('equipment', item.equipmentId)));
  diff.blockCapacityOverrides.forEach(item => keys.add(signatureKey('block', item.blockId)));
  return keys;
}

function applyDiffToProduction(scenario: Scenario, diff: ScenarioDiff) {
  if (diff.voyage) {
    const voyage = voyages.find(v => v.id === diff.voyage!.id)!;
    if (diff.voyage.patch.eta) voyage.eta = diff.voyage.patch.eta;
    if (diff.voyage.patch.etd) voyage.etd = diff.voyage.patch.etd;
  }
  for (const item of diff.earlyLoads) {
    const container = containers.find(c => c.id === item.containerId)!;
    let task = tasks.find(t => t.id === item.taskId) ?? tasks.find(t => t.containerId === item.containerId && t.kind === 'load' && t.status !== 'done');
    if (task) { task.from = item.from; task.to = item.to; task.scheduledAt = item.scheduledAt; }
    else { task = { id: `TASK-SCN-${Date.now()}-${tasks.length}`, kind: 'load', containerId: item.containerId, from: item.from, to: item.to, priority: 90, status: 'queued', scheduledAt: item.scheduledAt, blockingReasons: [], estimatedMinutes: 14 }; tasks.unshift(task); }
    container.lastEvent = `方案 ${scenario.id} 提前装船排程 ${fmt(new Date(item.scheduledAt))}`;
  }
  for (const item of diff.relocations) {
    const container = containers.find(c => c.id === item.containerId)!;
    const fromBlockId = parseBlock(container.yardSlot);
    const targetBlock = blocks.find(b => b.id === item.targetBlockId)!;
    if (fromBlockId && fromBlockId !== item.targetBlockId) {
      const fromBlock = blocks.find(b => b.id === fromBlockId);
      if (fromBlock) { fromBlock.occupied = Math.max(0, fromBlock.occupied - 1); if (container.reefer) fromBlock.usedPlugs = Math.max(0, fromBlock.usedPlugs - 1); }
      targetBlock.occupied += 1;
      if (container.reefer) targetBlock.usedPlugs += 1;
    }
    let task = tasks.find(t => t.id === item.taskId) ?? tasks.find(t => t.containerId === item.containerId && t.kind === 'rehandle' && t.status !== 'done');
    if (task) { task.from = item.from; task.to = item.to; task.scheduledAt = item.scheduledAt; }
    else { task = { id: `TASK-SCN-${Date.now()}-${tasks.length}`, kind: 'rehandle', containerId: item.containerId, from: item.from, to: item.to, priority: 80, status: 'queued', scheduledAt: item.scheduledAt, blockingReasons: [], estimatedMinutes: 26 }; tasks.unshift(task); }
    container.yardSlot = item.to;
    container.lastEvent = `方案 ${scenario.id} 移至更近区块 ${item.targetBlockId}`;
  }
  for (const item of diff.equipmentOverrides) {
    const machine = equipment.find(e => e.id === item.equipmentId)!;
    machine.movesPerHour = item.patch.movesPerHour;
  }
  for (const item of diff.blockCapacityOverrides) {
    const block = blocks.find(b => b.id === item.blockId)!;
    block.capacity = item.patch.capacity;
  }
}

/* ---------------- 重建基线 ---------------- */

export function rebaseScenario(id: string): ScenarioView {
  const scenario = requireScenario(id);
  if (scenario.computing) throw new ScenarioError(409, 'COMPUTE_RUNNING', '推演计算进行中，不能重建基线；请先取消计算');
  if (scenario.status === 'committed') throw new ScenarioError(409, 'SCENARIO_COMMITTED', '方案已提交，无需重建基线');
  const staleRevision = scenario.baseRevision;
  scenario.snapshot = snapshotProduction();
  scenario.baseRevision = productionRevision;
  scenario.baseSignatures = captureSignatures(scenario.snapshot);
  scenario.expiresAt = new Date(Date.now() + scenarioTtlMs).toISOString();
  scenario.result = undefined;
  scenario.status = 'draft';
  scenario.commitError = undefined;
  validateAdjustments(scenario.adjustments, scenario.snapshot);
  recordAudit('SCENARIO_REBASE', 'scenario', id, `重建基线 r${staleRevision} → r${productionRevision}，保留既有假设，需重新推演`);
  return toClient(scenario);
}

/* ---------------- 序列化 ---------------- */

export type ScenarioView = Omit<Scenario, 'snapshot' | 'computePromise' | 'computeToken' | 'cancelRequested'>;
function toClient(scenario: Scenario): ScenarioView {
  const { computePromise: _computePromise, computeToken: _token, cancelRequested: _cancel, snapshot: _snapshot, ...safe } = scenario;
  return safe;
}
