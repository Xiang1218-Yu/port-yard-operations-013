import { useCallback, useEffect, useRef, useState } from 'react';

type Basis = 'production-fact' | 'assumption';
type ScenarioStatus = 'draft' | 'computing' | 'computed' | 'interrupted' | 'committed' | 'expired' | 'discarded';

interface VoyageLite { id: string; vessel: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string; }
interface ContainerLite { id: string; voyageId: string; direction: string; status: string; customs: string; reefer: boolean; hazmatClass?: string; yardSlot: string; }
interface BlockLite { id: string; zone: string; capacity: number; occupied: number; reeferPlugs: number; usedPlugs: number; hazmatAllowed: boolean; }
interface EquipmentLite { id: string; name: string; kind: string; status: string; movesPerHour: number; }

interface RelocationRow { containerId: string; targetBlockId: string; }
interface EquipmentRow { equipmentId: string; movesPerHour: string; }
interface CapacityRow { blockId: string; capacity: string; }
export interface ScenarioForm {
  name: string; voyageId: string; eta: string; etd: string;
  earlyLoads: string[]; relocations: RelocationRow[]; equipment: EquipmentRow[]; capacities: CapacityRow[];
}

interface ScenarioRisk { severity: string; code: string; message: string; basis: Basis; }
interface ScenarioAssumption { id: string; label: string; detail: string; }
interface ScenarioResult {
  status: 'ready' | 'interrupted';
  interruptedAt?: string; progress?: string;
  basisNotes: { label: string; detail: string }[];
  assumptions: ScenarioAssumption[];
  remainingMoves: { production: number; projected: number; delta: number };
  window: { eta: string; etd: string; productionEta: string; productionEtd: string; windowMinutes: number; productionWindowMinutes: number; changed: boolean };
  workload: { quay: { requiredMinutes: number; effectiveMinutes: number; slackMinutes: number; feasible: boolean }; yard: { requiredMinutes: number; effectiveMinutes: number; slackMinutes: number; feasible: boolean }; truck: { effectiveMinutes: number }; earlyLeadMinutes: number; earlyLeadFeasible: boolean };
  overallRisk: string; risks: ScenarioRisk[];
  affectedTasks: { taskId?: string; containerId: string; kind: string; change: string; detail: string; scheduledAt: string; estimatedMinutes: number; basis: Basis }[];
  blockImpacts: { blockId: string; zone: string; occupied: number; productionOccupied: number; capacity: number; productionCapacity: number; utilization: number; deltaOccupancy: number; capacityChanged: boolean; feasible: boolean; basis: Basis; note?: string }[];
  metrics: { key: string; label: string; production: number; projected: number; delta: number; unit: string; basis: Basis }[];
  stats: { earlyLoads: number; relocations: number; rejectedEarlyLoads: number; rejectedRelocations: number; affectedTaskCount: number };
}
interface CommitConflict { code: string; entity: string; entityId: string; message: string; competingScenarioId?: string; }
interface ScenarioView {
  id: string; name: string; voyageId: string; createdBy: string; createdAt: string; expiresAt: string;
  baseRevision: number; status: ScenarioStatus; computing: boolean;
  adjustments: { eta?: string; etd?: string; earlyLoadContainerIds?: string[]; relocations?: { containerId: string; targetBlockId: string }[]; equipmentOverrides?: { equipmentId: string; movesPerHour?: number }[]; blockCapacityOverrides?: { blockId: string; capacity?: number }[] };
  result?: ScenarioResult;
  commitError?: { baseRevision: number; currentRevision: number; conflicts: CommitConflict[] };
}
interface ApiErrorBody { message: string; code?: string; report?: { baseRevision: number; currentRevision: number; conflicts: CommitConflict[] }; }

export interface ScenarioStudioProps {
  voyages: VoyageLite[]; containers: ContainerLite[]; blocks: BlockLite[]; equipment: EquipmentLite[];
}

const api = (path: string) => `/api/scenarios${path}`;
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(api(path), { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `请求失败 (${response.status})`), { body: body as ApiErrorBody });
  return body as T;
}
const toLocalInput = (value?: string) => { const date = value ? new Date(value) : new Date(); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const pct = (value: number) => `${Math.round(value * 100)}%`;

function BasisTag({ basis }: { basis: Basis }) {
  return basis === 'assumption'
    ? <span className="basis-tag assumption" title="该结论仅在当前方案假设下成立，尚未写入生产"><i>◆</i> 假设推演</span>
    : <span className="basis-tag fact" title="该结论来自方案基线对应的生产事实快照"><i>●</i> 当前生产实测</span>;
}
const riskClass = (risk: string) => risk === 'high' ? 'critical' : risk === 'medium' ? 'warning' : 'ok';
const fact: Basis = 'production-fact';
const statusLabel: Record<ScenarioStatus, string> = { draft: '待推演', computing: '计算中', computed: '已推演', interrupted: '计算中断', committed: '已提交生产', expired: '方案过期', discarded: '已放弃' };

export default function ScenarioStudio({ voyages, containers, blocks, equipment }: ScenarioStudioProps) {
  const [scenarios, setScenarios] = useState<ScenarioView[]>([]);
  const [revision, setRevision] = useState<number>();
  const [selectedId, setSelectedId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [pageError, setPageError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<ScenarioForm>(() => emptyForm(voyages[0]?.id));
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function emptyForm(voyageId?: string): ScenarioForm {
    const voyage = voyages.find(v => v.id === voyageId) ?? voyages[0];
    return { name: '', voyageId: voyage?.id ?? '', eta: toLocalInput(voyage?.eta), etd: toLocalInput(voyage?.etd), earlyLoads: [], relocations: [{ containerId: '', targetBlockId: '' }], equipment: [{ equipmentId: '', movesPerHour: '' }], capacities: [{ blockId: '', capacity: '' }] };
  }

  const refresh = useCallback(async (silent = false) => {
    try {
      const [list, state] = await Promise.all([request<ScenarioView[]>(''), request<{ revision: number }>('/state')]);
      setScenarios(list); setRevision(state.revision);
      setSelectedId(current => current || list[0]?.id || '');
    } catch (error) { if (!silent) setPageError(error instanceof Error ? error.message : '无法加载推演方案'); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const selected = scenarios.find(s => s.id === selectedId);
  const computing = Boolean(selected?.computing);
  useEffect(() => {
    if (!computing) return;
    pollRef.current = setTimeout(() => { void refresh(true); }, 1200);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [computing, selected?.status, refresh]);

  const setError = (error: unknown) => setPageError(error instanceof Error ? error.message : '操作失败');
  const voyageOptions = voyages.filter(v => v.status !== 'departed');

  const createScenario = async () => {
    const voyage = voyages.find(v => v.id === form.voyageId);
    if (!voyage) { setPageError('请选择航次'); return; }
    const payload = {
      name: form.name || `${voyage.id} 靠泊窗口推演 ${new Date().toLocaleTimeString()}`,
      voyageId: form.voyageId,
      adjustments: {
        eta: form.eta ? new Date(form.eta).toISOString() : undefined,
        etd: form.etd ? new Date(form.etd).toISOString() : undefined,
        earlyLoadContainerIds: form.earlyLoads,
        relocations: form.relocations.filter(r => r.containerId && r.targetBlockId),
        equipmentOverrides: form.equipment.filter(e => e.equipmentId && e.movesPerHour !== '').map(e => ({ equipmentId: e.equipmentId, movesPerHour: Number(e.movesPerHour) })),
        blockCapacityOverrides: form.capacities.filter(c => c.blockId && c.capacity !== '').map(c => ({ blockId: c.blockId, capacity: Number(c.capacity) }))
      }
    };
    setBusy(true); setPageError('');
    try {
      const created = await request<ScenarioView>('', { method: 'POST', body: JSON.stringify(payload) });
      setShowCreate(false); setSelectedId(created.id); setNotice(`方案 ${created.id} 已在隔离副本上创建（基线 r${created.baseRevision}），尚未影响生产`);
      await refresh(true);
    } catch (error) { setError(error); } finally { setBusy(false); }
  };

  const runCompute = async (id: string) => {
    setBusy(true); setPageError(''); setNotice('');
    try {
      await request(`/${id}/compute`, { method: 'POST', body: JSON.stringify({}) });
      await refresh(true);
    } catch (error) { setError(error); } finally { setBusy(false); }
  };
  const runComputeSlow = async (id: string) => {
    setBusy(true); setPageError(''); setNotice('已启动可中断的分阶段推演（每阶段 300ms），可随时点击「中断计算」');
    try {
      await request(`/${id}/compute`, { method: 'POST', body: JSON.stringify({ await: false, stepDelayMs: 300 }) });
      await refresh(true);
    } catch (error) { setError(error); } finally { setBusy(false); }
  };
  const cancelCompute = async (id: string) => {
    setPageError('');
    try { await request(`/${id}/cancel`, { method: 'POST' }); await new Promise(resolve => setTimeout(resolve, 400)); await refresh(true); setNotice('推演计算已中断：已保留阶段性状态，不完整结果禁止提交'); }
    catch (error) { setError(error); }
  };
  const commit = async (id: string) => {
    if (!window.confirm('确认把该方案的差异提交回生产状态？仅方案中调整过的字段会被写入。')) return;
    setBusy(true); setPageError(''); setNotice('');
    try {
      const receipt = await request<{ revision: number }>(`/${id}/commit`, { method: 'POST' });
      setNotice(`方案差异已提交到生产，新版本 r${receipt.revision}`);
      await refresh(true);
    } catch (error) { await refresh(true); setError(error); } finally { setBusy(false); }
  };
  const rebase = async (id: string) => {
    setBusy(true); setPageError('');
    try {
      const rebased = await request<ScenarioView>(`/${id}/rebase`, { method: 'POST' });
      setNotice(`已基于最新生产 r${rebased.baseRevision} 重建基线，假设保留，请重新推演后再提交`);
      await refresh(true);
    } catch (error) { setError(error); } finally { setBusy(false); }
  };
  const discard = async (id: string) => {
    if (!window.confirm('放弃该推演方案？不会对生产产生任何写入。')) return;
    setBusy(true);
    try { await request(`/${id}`, { method: 'DELETE' }); setSelectedId(''); await refresh(true); setNotice('方案已放弃，生产数据未受影响'); }
    catch (error) { setError(error); } finally { setBusy(false); }
  };

  const updateForm = (patch: Partial<ScenarioForm>) => setForm(current => ({ ...current, ...patch }));
  const voyageContainers = containers.filter(c => c.voyageId === form.voyageId);

  return <div className="scenario-studio">
    <div className="panel wide">
      <div className="panel-head">
        <div>
          <div className="eyebrow">WHAT-IF SCENARIO STUDIO / 航次作业情景推演</div>
          <h2>靠泊窗口缩短作业推演</h2>
          <span className="muted">在隔离副本上调整 ETA/ETD、目标箱集（提前装船 / 近区块移箱）、设备能力与区块容量；提交前所有计算都不会写入生产</span>
        </div>
        <div className="scenario-head-actions">
          <span className="revision-chip">生产版本 {revision ? `r${revision}` : '…'}</span>
          <button className="primary-action" onClick={() => { setForm(emptyForm()); setShowCreate(value => !value); setPageError(''); }}>{showCreate ? '收起新建' : '＋ 新建推演方案'}</button>
        </div>
      </div>
      <div className="basis-legend"><BasisTag basis="assumption" /><span>= 仅在本方案假设下成立，提交前不影响生产</span><BasisTag basis={fact} /><span>= 方案基线快照中的生产事实</span><span className="muted">提交时进行乐观版本校验；推演期间生产变更若与方案相交会产生冲突</span></div>
      {notice && <div className="toast-inline ok" onClick={() => setNotice('')}>{notice} ×</div>}
      {pageError && <div className="toast-inline error" onClick={() => setPageError('')}>{pageError} ×</div>}

      {showCreate && <div className="scenario-create">
        <div className="form-grid">
          <label>方案名称<input value={form.name} onChange={e => updateForm({ name: e.target.value })} placeholder="例如：AX7 窗口压缩 90 分钟应急方案" /></label>
          <label>推演航次<select value={form.voyageId} onChange={e => { updateForm({ voyageId: e.target.value, earlyLoads: [] }); }}>{voyageOptions.map(v => <option key={v.id} value={v.id}>{v.id} · {v.vessel} · {v.berth}</option>)}</select></label>
          <label className="assumption-field">假设 ETA <small>留空 = 沿用生产</small><input type="datetime-local" value={form.eta} onChange={e => updateForm({ eta: e.target.value })} /></label>
          <label className="assumption-field">假设 ETD <small>留空 = 沿用生产</small><input type="datetime-local" value={form.etd} onChange={e => updateForm({ etd: e.target.value })} /></label>
        </div>
        <div className="assumption-section">
          <div className="assumption-title"><span className="basis-tag assumption"><i>◆</i> 提前装船目标箱集</span><small>勾选后在假设窗口 ETA 排程装船</small></div>
          <div className="check-grid">{voyageContainers.filter(c => c.direction !== 'import').map(c => <label key={c.id} className="check-pill"><input type="checkbox" checked={form.earlyLoads.includes(c.id)} onChange={e => updateForm({ earlyLoads: e.target.checked ? [...form.earlyLoads, c.id] : form.earlyLoads.filter(id => id !== c.id) })} />{c.id}<small>{c.status} · 海关 {c.customs}</small></label>)}{voyageContainers.filter(c => c.direction !== 'import').length === 0 && <span className="muted">该航次暂无出口/中转箱可选</span>}</div>
        </div>
        <div className="assumption-section">
          <div className="assumption-title"><span className="basis-tag assumption"><i>◆</i> 移到更近区块</span><small>危险品 / 冷藏 / 容量约束会在推演中逐项校验</small></div>
          {form.relocations.map((row, index) => <div className="row-editor" key={index}>
            <select value={row.containerId} onChange={e => updateForm({ relocations: form.relocations.map((r, i) => i === index ? { ...r, containerId: e.target.value } : r) })}><option value="">选择箱号</option>{containers.filter(c => c.status !== 'released').map(c => <option key={c.id} value={c.id}>{c.id} · {c.yardSlot}</option>)}</select>
            <span>→</span>
            <select value={row.targetBlockId} onChange={e => updateForm({ relocations: form.relocations.map((r, i) => i === index ? { ...r, targetBlockId: e.target.value } : r) })}><option value="">目标区块</option>{blocks.map(b => <option key={b.id} value={b.id}>{b.id} · {b.zone}（{b.occupied}/{b.capacity}）</option>)}</select>
            <button type="button" className="danger-action" onClick={() => updateForm({ relocations: form.relocations.filter((_, i) => i !== index) })}>移除</button>
          </div>)}
          <button type="button" className="link-action" onClick={() => updateForm({ relocations: [...form.relocations, { containerId: '', targetBlockId: '' }] })}>＋ 增加移箱</button>
        </div>
        <div className="assumption-section">
          <div className="assumption-title"><span className="basis-tag assumption"><i>◆</i> 设备能力假设</span><small>直接指定推演用 moves/h</small></div>
          {form.equipment.map((row, index) => <div className="row-editor" key={index}>
            <select value={row.equipmentId} onChange={e => updateForm({ equipment: form.equipment.map((r, i) => i === index ? { ...r, equipmentId: e.target.value, movesPerHour: String(equipment.find(item => item.id === e.target.value)?.movesPerHour ?? '') } : r) })}><option value="">选择设备</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name}（实测 {item.movesPerHour}/h · {item.status}）</option>)}</select>
            <input type="number" min="0" placeholder="假设 moves/h" value={row.movesPerHour} onChange={e => updateForm({ equipment: form.equipment.map((r, i) => i === index ? { ...r, movesPerHour: e.target.value } : r) })} />
            <button type="button" className="danger-action" onClick={() => updateForm({ equipment: form.equipment.filter((_, i) => i !== index) })}>移除</button>
          </div>)}
          <button type="button" className="link-action" onClick={() => updateForm({ equipment: [...form.equipment, { equipmentId: '', movesPerHour: '' }] })}>＋ 增加设备</button>
        </div>
        <div className="assumption-section">
          <div className="assumption-title"><span className="basis-tag assumption"><i>◆</i> 区块容量假设</span><small>直接指定推演用容量上限</small></div>
          {form.capacities.map((row, index) => <div className="row-editor" key={index}>
            <select value={row.blockId} onChange={e => updateForm({ capacities: form.capacities.map((r, i) => i === index ? { ...r, blockId: e.target.value, capacity: String(blocks.find(item => item.id === e.target.value)?.capacity ?? '') } : r) })}><option value="">选择区块</option>{blocks.map(b => <option key={b.id} value={b.id}>{b.id}（当前 {b.capacity}）</option>)}</select>
            <input type="number" min="0" placeholder="假设容量" value={row.capacity} onChange={e => updateForm({ capacities: form.capacities.map((r, i) => i === index ? { ...r, capacity: e.target.value } : r) })} />
            <button type="button" className="danger-action" onClick={() => updateForm({ capacities: form.capacities.filter((_, i) => i !== index) })}>移除</button>
          </div>)}
          <button type="button" className="link-action" onClick={() => updateForm({ capacities: [...form.capacities, { blockId: '', capacity: '' }] })}>＋ 增加区块</button>
        </div>
        <div className="modal-actions"><button type="button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-action" disabled={busy} onClick={createScenario}>{busy ? '创建中…' : '在隔离副本上创建方案'}</button></div>
      </div>}
    </div>

    <div className="layout">
      <section className="panel scenario-list">
        <div className="panel-head"><h3>方案列表</h3><span className="muted">隔离沙箱 · 不写生产</span></div>
        {scenarios.length === 0 && <div className="muted">暂无方案，点击右上角新建。</div>}
        {scenarios.map(item => <button key={item.id} className={`scenario-item ${selectedId === item.id ? 'selected' : ''}`} onClick={() => { setSelectedId(item.id); setPageError(''); }}>
          <div className="scenario-item-top"><b>{item.name}</b><span className={`pill scenario-status ${item.status}`}>{statusLabel[item.status]}</span></div>
          <small>{item.id} · {item.voyageId} · 基线 r{item.baseRevision}{revision !== undefined && revision > item.baseRevision && item.status !== 'committed' ? <em className="stale-flag"> 生产已变更 {revision - item.baseRevision} 版</em> : ''}</small>
          <small>创建 {new Date(item.createdAt).toLocaleString()} · {item.createdBy}</small>
        </button>)}
      </section>

      {selected ? <ScenarioDetail key={selected.id} scenario={selected} productionRevision={revision ?? selected.baseRevision} busy={busy} onCompute={runCompute} onComputeSlow={runComputeSlow} onCancel={cancelCompute} onCommit={commit} onRebase={rebase} onDiscard={discard} blocks={blocks} /> : <section className="panel"><span className="muted">选择或创建一个方案查看推演结论。</span></section>}
    </div>
  </div>;
}

function ScenarioDetail(props: { scenario: ScenarioView; productionRevision: number; busy: boolean; blocks: BlockLite[]; onCompute: (id: string) => void; onComputeSlow: (id: string) => void; onCancel: (id: string) => void; onCommit: (id: string) => void; onRebase: (id: string) => void; onDiscard: (id: string) => void; }) {
  const { scenario: s, productionRevision, busy, blocks } = props;
  const r = s.result;
  const stale = productionRevision > s.baseRevision && s.status !== 'committed';
  const editable = ['draft', 'computed', 'interrupted'].includes(s.status);

  return <section className="panel scenario-detail">
    <div className="panel-head">
      <div><div className="eyebrow">{s.id} / BASE r{s.baseRevision}</div><h3>{s.name}</h3><span className="muted">有效期至 {new Date(s.expiresAt).toLocaleString()}</span></div>
      <div className="detail-actions">
        {editable && <button disabled={busy || s.computing} onClick={() => props.onCompute(s.id)}>重新推演</button>}
        {editable && <button className="ghost-action" disabled={busy || s.computing} onClick={() => props.onComputeSlow(s.id)}>分阶段推演（可中断）</button>}
        {s.computing && <button className="danger-action" onClick={() => props.onCancel(s.id)}>中断计算</button>}
        {(s.status === 'computed' || s.status === 'interrupted' || stale) && <button disabled={busy || s.computing} onClick={() => props.onRebase(s.id)}>重建基线</button>}
        {s.status === 'computed' && <button className="primary-action" disabled={busy || stale} onClick={() => props.onCommit(s.id)}>差异提交生产</button>}
        {s.status !== 'committed' && <button className="danger-action" disabled={busy} onClick={() => props.onDiscard(s.id)}>放弃</button>}
      </div>
    </div>

    {s.computing && <div className="compute-banner"><span className="spinner" /> 推演计算进行中（隔离副本）… 页面自动刷新，可中断</div>}
    {s.status === 'interrupted' && <div className="conflict"><strong>interrupted</strong><span>推演计算被中断于「{r?.progress ?? '未知阶段'}」，结果不完整且禁止提交；可重新推演或调整假设。</span></div>}
    {s.status === 'expired' && <div className="conflict"><strong>expired</strong><span>方案已超过有效期，基线过旧；请重建基线后重新推演。</span></div>}
    {s.status === 'committed' && <div className="toast-inline ok">方案差异已于此前提交到生产（提交后生产版本再变不影响此记录）。</div>}
    {stale && s.status !== 'expired' && !s.computing && <div className="conflict"><strong>stale</strong><span>推演期间生产已从 r{s.baseRevision} 推进到 r{productionRevision}。不相交的变更不影响提交；提交时仍会逐实体做签名校验，也可先重建基线。</span></div>}

    {s.commitError && <div className="conflict-report">
      <div className="conflict-report-head"><strong>COMMIT CONFLICT · 提交被拒</strong><span>基线 r{s.commitError.baseRevision} → 当前生产 r{s.commitError.currentRevision}，共 {s.commitError.conflicts.length} 项冲突</span></div>
      {s.commitError.conflicts.map((c, i) => <div className="conflict" key={`${c.code}-${c.entityId}-${i}`}><strong>{c.code.replace('CONFLICT_', '').replace(/_/g, ' ')}</strong><b>{c.entity}:{c.entityId}</b><span>{c.message}</span></div>)}
      <div className="conflict-report-actions"><button className="primary-action" disabled={busy} onClick={() => props.onRebase(s.id)}>重建基线并保留假设</button><span className="muted">重建后需重新推演；冲突中的生产当前值可用于人工裁决</span></div>
    </div>}

    {!r && !s.computing && <div className="muted">尚未推演。点击「重新推演」在隔离副本上计算预计剩余 moves、风险与受影响任务。</div>}

    {r && <>
      <div className="assumption-summary">
        <div className="overall-risk"><small>综合风险</small><b className={riskClass(r.overallRisk)}>{r.overallRisk === 'high' ? 'HIGH 高风险' : r.overallRisk === 'medium' ? 'WATCH 需关注' : 'LOW 可控'}</b><BasisTag basis="assumption" /></div>
        {r.metrics.map(m => <div className="metric-card" key={m.key}><small>{m.label}</small><b>{m.projected}<em>{m.unit}</em></b><span className={m.delta > 0 ? 'delta-up' : m.delta < 0 ? 'delta-down' : ''}>{m.delta > 0 ? '+' : ''}{m.delta} {m.unit}（生产 {m.production}）</span><BasisTag basis={m.basis} /></div>)}
      </div>

      <div className="result-grid">
        <div className="result-block">
          <h4>靠泊窗口与设备产能 <BasisTag basis={r.window.changed ? 'assumption' : 'production-fact'} /></h4>
          <div className="kv"><span>窗口</span><b>{time(r.window.eta)} – {time(r.window.etd)}</b>{r.window.changed ? <small>生产：{time(r.window.productionEta)} – {time(r.window.productionEtd)}</small> : <small>与生产一致</small>}</div>
          <div className="kv"><span>窗口时长</span><b>{r.window.windowMinutes} 分钟</b><small>生产 {r.window.productionWindowMinutes} 分钟</small></div>
          <WorkloadRow label="岸桥" band={r.workload.quay} />
          <WorkloadRow label="场桥/正面吊" band={r.workload.yard} />
          <div className="kv"><span>提前装船提前期</span><b className={r.workload.earlyLeadFeasible ? 'ok' : 'critical'}>{r.workload.earlyLeadMinutes} 分钟{r.workload.earlyLeadFeasible ? ' · 够用' : ' · 不足'}</b></div>
          <div className="kv"><span>剩余 moves</span><b>{r.remainingMoves.projected}</b><small>生产基线 {r.remainingMoves.production}，假设提前装船减少 {-r.remainingMoves.delta}</small></div>
          <div className="kv"><span>目标处理</span><b>{r.stats.earlyLoads} 提前 / {r.stats.relocations} 移箱</b><small>否决 {r.stats.rejectedEarlyLoads + r.stats.rejectedRelocations} 个目标</small></div>
        </div>

        <div className="result-block">
          <h4>风险清单 <small className="muted">按来源标注</small></h4>
          <div className="risk-list">{r.risks.map((risk, i) => <div className={`risk-row ${risk.severity}`} key={`${risk.code}-${i}`}><i className={`risk-dot ${risk.severity}`} /><span>{risk.message}</span><BasisTag basis={risk.basis} /></div>)}</div>
        </div>
      </div>

      <div className="result-block">
        <h4>受影响任务 <small className="muted">{r.stats.affectedTaskCount} 项 · 全部为假设排程，提交时才落到生产任务队列</small></h4>
        <div className="table compact-table">
          <div className="tr th"><span>变化类型</span><span>箱号 / 任务</span><span>说明</span><span>假设排程</span><span>来源</span></div>
          {r.affectedTasks.map((t, i) => <div className="tr" key={`${t.containerId}-${t.change}-${i}`}><span>{t.change}{t.taskId ? <small>{t.taskId}</small> : <small>将新建任务</small>}</span><span><b>{t.containerId}</b><small>{t.kind} · {t.estimatedMinutes}min</small></span><span>{t.detail}</span><span>{new Date(t.scheduledAt).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span><span><BasisTag basis={t.basis} /></span></div>)}
          {r.affectedTasks.length === 0 && <div className="tr"><span className="muted">无任务变化</span></div>}
        </div>
      </div>

      <div className="result-block">
        <h4>区块容量推演</h4>
        <div className="yard-grid scenario-yard">{r.blockImpacts.map(b => <div className={`block ${!b.feasible ? 'critical' : b.basis === 'assumption' ? 'warning' : ''}`} key={b.blockId}>
          <div className="block-top"><b>{b.blockId}</b><strong>{pct(b.utilization)}</strong></div>
          <span>{b.zone}</span>
          <div className="block-stats"><span>推演 {b.occupied}/{b.capacity}</span><span>生产 {b.productionOccupied}/{b.productionCapacity}</span><span>{b.feasible ? '可容纳' : '容量不足'}</span></div>
          <div className="block-basis"><BasisTag basis={b.basis} />{b.note && <small>{b.note}</small>}</div>
        </div>)}</div>
      </div>

      <div className="result-grid">
        <div className="result-block">
          <h4>本方案采用的假设</h4>
          <ul className="assumption-list">{r.assumptions.map(a => <li key={a.id}><b>{a.label}</b><span>{a.detail}</span></li>)}{r.assumptions.length === 0 && <li className="muted">未设置任何假设调整，推演结论等同于生产基线。</li>}</ul>
        </div>
        <div className="result-block">
          <h4>结论来源说明</h4>
          <ul className="assumption-list">{r.basisNotes.map((n, i) => <li key={i}><b>{n.label}</b><span>{n.detail}</span></li>)}</ul>
        </div>
      </div>
    </>}
  </section>;
}

function WorkloadRow({ label, band: w }: { label: string; band: { requiredMinutes: number; effectiveMinutes: number; slackMinutes: number; feasible: boolean } }) {
  return <div className="kv"><span>{label}产能</span><b className={w.feasible ? 'ok' : 'critical'}>{w.feasible ? '满足' : '缺口'} {Math.abs(w.slackMinutes)} 分钟</b><small>需 {w.requiredMinutes} / 可用 {w.effectiveMinutes}</small></div>;
}
