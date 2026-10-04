import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ---------------- 类型（与服务端 scenarios.ts 对应） ---------------- */

type Voyage = { id: string; vessel: string; service: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string };
type Container = { id: string; voyageId: string; reefer: boolean; hazmatClass?: string; customs: string; status: string; yardSlot: string };
type Block = { id: string; zone: string; capacity: number; occupied: number; reeferPlugs: number; usedPlugs: number; hazmatAllowed: boolean };
type Equipment = { id: string; name: string; kind: string; status: string; movesPerHour: number };

type ScenarioSummary = { id: string; name: string; status: string; createdAt: string; baseVersion: number; currentVersion: number; stale: boolean; expiresInMs: number; hasResult: boolean; voyageId: string };
type Basis = 'production' | 'assumption';
type Risk = { level: 'low'|'medium'|'high'; code: string; message: string; basis: Basis };
type AffectedTask = { taskId?: string; kind: string; containerId: string; from: string; to: string; change: string; basis: Basis; status: string; scheduledShiftMin?: number; blockingReasons: string[] };
type BlockCapacity = { blockId: string; capacity: number; occupied: number; utilization: number; freeSlots: number; deltaIn: number; deltaOut: number; feasible: boolean; basis: Basis };
type Result = {
  windowMinutes: number; windowBaselineMinutes: number; remainingMoves: number; remainingMovesBaseline: number;
  earlyMoves: number; relocationMoves: number; throughputMoves: number; completable: boolean; overrunMoves: number;
  equipmentCapacityMph: number; lateRisk: 'low'|'medium'|'high'; risks: Risk[]; affectedTasks: AffectedTask[];
  blockCapacities: BlockCapacity[]; assumptionsApplied: string[]; computedAt: string; interrupted: false;
};
type DiffEntry = { entity: string; id: string; action: string; changes?: Record<string, { from: unknown; to: unknown }>; payload?: Record<string, unknown>; basis: Basis };
type CommitInfo = { committedAt: string; version: number; diff: DiffEntry[] };
type ConflictDetail = { baseVersion: number; currentVersion: number; changedEntities: { entity: string; id: string; type: string }[] };
type ScenarioDetail = {
  id: string; name: string; createdAt: string; expiresAt: number; baseVersion: number; status: string;
  assumptions: {
    voyageId: string; eta?: string; etd?: string; earlyLoadContainerIds: string[];
    relocations: { containerId: string; toBlockId: string }[];
    equipmentOverrides: { equipmentId: string; movesPerHour?: number; status?: string }[];
    capacityOverrides: { blockId: string; capacity?: number; occupied?: number }[];
    note?: string;
  };
  result?: Result; partial?: { interrupted: true; interruptedAt: string; progress: string };
  lastError?: { code: string; message: string };
  commit?: CommitInfo;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `请求失败 (${response.status})`), { code: body.code, details: body.details, status: response.status });
  return body as T;
}

const toLocalInput = (value?: string) => {
  const date = value ? new Date(value) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fmtMin = (min: number) => `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}m`;
const fmtCountdown = (ms: number) => ms <= 0 ? '已过期' : `${Math.floor(ms / 60000)}分${Math.round((ms % 60000) / 1000)}秒`;
const riskLabel = (level: string) => level === 'high' ? '高风险' : level === 'medium' ? '需关注' : '可控';

const STATUS_TEXT: Record<string, string> = {
  draft: '待推演', computing: '推演中…', ready: '可提交', interrupted: '已中断', stale: '基线过期', committed: '已提交', expired: '已失效',
};

/* ---------------- 假设/生产来源徽标 ---------------- */
function BasisTag({ basis }: { basis: Basis }) {
  return basis === 'assumption'
    ? <span className="basis-tag assumption" title="该结论来自本方案设定的假设，尚未写入生产系统">假设推演</span>
    : <span className="basis-tag production" title="该结论读取自当前生产状态快照">生产现状</span>;
}

/* ---------------- 主组件 ---------------- */

export default function Scenarios({ voyages, containers, blocks, equipment, onCommitted }: {
  voyages: Voyage[]; containers: Container[]; blocks: Block[]; equipment: Equipment[]; onCommitted: () => void;
}) {
  const [list, setList] = useState<ScenarioSummary[]>([]);
  const [detail, setDetail] = useState<ScenarioDetail>();
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<{ message: string; detail?: ConflictDetail }>();
  const [commitDiff, setCommitDiff] = useState<CommitInfo>();
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const refreshList = useCallback(async () => {
    try { setList(await request<ScenarioSummary[]>('/scenarios')); } catch { /* 轮询静默 */ }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const next = await request<ScenarioDetail>(`/scenarios/${id}`);
      setDetail(next);
      return next;
    } catch (reason) { setError(reason instanceof Error ? reason.message : '读取方案失败'); return undefined; }
  }, []);

  useEffect(() => { void refreshList(); }, [refreshList]);
  useEffect(() => {
    const tick = window.setInterval(() => {
      void refreshList();
      if (detail && (detail.status === 'computing')) void refreshDetail(detail.id);
    }, 1500);
    timerRef.current = tick;
    return () => window.clearInterval(tick);
  }, [refreshList, refreshDetail, detail?.id, detail?.status]);

  const open = async (id: string) => {
    setConflict(undefined); setCommitDiff(undefined); setError('');
    await refreshDetail(id);
  };

  const startCompute = async (id: string) => {
    setError('');
    try {
      await request(`/scenarios/${id}/compute`, { method: 'POST' });
      await refreshDetail(id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '启动推演失败'); }
  };
  const interrupt = async (id: string) => {
    try { await request(`/scenarios/${id}/interrupt`, { method: 'POST' }); await refreshDetail(id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '中断失败'); }
  };
  const discard = async (id: string) => {
    if (!window.confirm('放弃并删除该隔离方案？不会影响任何生产数据。')) return;
    try { await request(`/scenarios/${id}`, { method: 'DELETE' }); setDetail(undefined); await refreshList(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败'); }
  };

  const handleCreated = async (id: string) => {
    setShowForm(false);
    await refreshList();
    await open(id);
    void startCompute(id); // 创建后立即在隔离副本上推演
  };

  const rebuild = async (scenario: ScenarioDetail) => {
    if (!window.confirm('以相同假设、基于当前生产状态创建新方案？旧方案保留备查。')) return;
    try {
      const created = await request<ScenarioDetail>('/scenarios', { method: 'POST', body: JSON.stringify({ name: `${scenario.name}（重建）`, assumptions: scenario.assumptions }) });
      setConflict(undefined);
      await handleCreated(created.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '重建失败'); }
  };

  const commit = async (scenario: ScenarioDetail) => {
    if (!window.confirm('把该方案的差异提交回生产状态？提交前会再次校验版本与容量/箱况。')) return;
    setBusy(true); setError(''); setConflict(undefined);
    try {
      const result = await request<CommitInfo>(`/scenarios/${scenario.id}/commit`, { method: 'POST', body: JSON.stringify({}) });
      setCommitDiff(result);
      const latest = await refreshDetail(scenario.id);
      await refreshList();
      onCommitted();
      if (latest?.status === 'committed') setDetail(latest);
    } catch (reason) {
      const err = reason as Error & { code?: string; details?: ConflictDetail };
      if (err.code === 'VERSION_CONFLICT') setConflict({ message: err.message, detail: err.details });
      else setError(err.message || '提交失败');
    } finally { setBusy(false); };
  };

  const activeVoyages = useMemo(() => voyages.filter(v => v.status !== 'departed'), [voyages]);

  return <section className="panel wide scenarios-panel">
    <div className="panel-head">
      <div>
        <div className="eyebrow">VOYAGE WHAT-IF / 航次作业情景推演</div>
        <h2>靠泊窗口情景沙盘</h2>
        <span className="muted">基于当前内存状态创建隔离副本：调整 ETA/ETD、目标箱集、设备能力、区块容量后推演剩余 moves 与风险；结论以差异形式提交回生产。</span>
      </div>
      <button className="primary-action" onClick={() => { setShowForm(value => !value); setError(''); }}>{showForm ? '收起创建面板' : '＋ 新建推演方案'}</button>
    </div>

    <div className="scenario-legend">
      <BasisTag basis="assumption" /><span>假设推演值：沙盘副本内的试探调整，生产数据不变</span>
      <BasisTag basis="production" /><span>生产现状：创建方案时的生产快照基线，受版本保护</span>
    </div>

    {error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}

    {showForm && <ScenarioForm voyages={activeVoyages} containers={containers} blocks={blocks} equipment={equipment} busy={busy} onCreated={handleCreated} onCancel={() => setShowForm(false)} />}

    <div className="scenario-layout">
      <div className="scenario-list">
        <div className="scenario-list-head"><h3>方案列表</h3><span>{list.length} 个隔离副本</span></div>
        {list.length === 0 && <p className="empty-hint">还没有方案。点击「新建推演方案」，先选航次再设定提前装船箱集与移箱假设。</p>}
        {list.map(item => <button key={item.id} className={`scenario-card ${detail?.id === item.id ? 'selected' : ''} ${item.stale ? 'is-stale' : ''}`} onClick={() => void open(item.id)}>
          <div className="scenario-card-top"><b>{item.name}</b><span className={`scenario-status status-${item.status}`}>{STATUS_TEXT[item.status] ?? item.status}</span></div>
          <small>{item.id} · {item.voyageId}</small>
          <div className="scenario-card-meta">
            <span>基线 v{item.baseVersion}{item.currentVersion !== item.baseVersion && <em className="version-drift"> → 生产 v{item.currentVersion}</em>}</span>
            <span>剩余 {fmtCountdown(item.expiresInMs)}</span>
          </div>
          {item.stale && <small className="stale-warn">生产已变更，提交将产生版本冲突，可一键重建</small>}
        </button>)}
      </div>

      <div className="scenario-detail">
        {!detail && <div className="empty-detail"><div className="eyebrow">SANDBOX DETAIL</div><h3>选择左侧方案查看推演结论</h3><p>所有计算只发生在该方案的隔离副本上；提交采用乐观锁，推演期间生产被改动会被拒绝并列出冲突实体。</p></div>}
        {detail && <ScenarioDetailView key={detail.id} scenario={detail} summary={list.find(s => s.id === detail.id)} busy={busy}
          onCompute={() => void startCompute(detail.id)} onInterrupt={() => void interrupt(detail.id)} onDiscard={() => void discard(detail.id)}
          onCommit={() => void commit(detail)} onRebuild={() => void rebuild(detail)} conflict={conflict} commitInfo={commitDiff} />}
      </div>
    </div>
  </section>;
}

/* ---------------- 详情/结论视图 ---------------- */

function ScenarioDetailView({ scenario, summary, busy, onCompute, onInterrupt, onDiscard, onCommit, onRebuild, conflict, commitInfo }: {
  scenario: ScenarioDetail; summary?: ScenarioSummary; busy: boolean;
  onCompute: () => void; onInterrupt: () => void; onDiscard: () => void; onCommit: () => void; onRebuild: () => void;
  conflict?: { message: string; detail?: ConflictDetail }; commitInfo?: CommitInfo;
}) {
  const r = scenario.result;
  const stale = summary?.stale ?? scenario.baseVersion !== summary?.currentVersion;
  const canCommit = scenario.status === 'ready' || (scenario.status === 'stale');
  return <div>
    <div className="detail-head">
      <div>
        <h3>{scenario.name}</h3>
        <small>{scenario.id} · 创建于 {new Date(scenario.createdAt).toLocaleString()} · 基线版本 v{scenario.baseVersion}{summary && <> · 当前生产 v{summary.currentVersion}</>}</small>
      </div>
      <span className={`scenario-status status-${scenario.status}`}>{STATUS_TEXT[scenario.status] ?? scenario.status}</span>
    </div>

    <AssumptionSummary scenario={scenario} />

    {scenario.status === 'computing' && <div className="compute-banner">
      <span className="spinner" /> 正在隔离副本上分阶段推演（窗口 → 提前装船 → 移箱容量 → 设备吞吐 → 任务影响）…
      <button className="danger-action" onClick={onInterrupt}>中断计算</button>
    </div>}
    {scenario.status === 'interrupted' && <div className="banner warning">
      <b>推演已中断</b><span>{scenario.partial?.progress ?? '计算被手动中断，结论不完整，不能提交。'}<br/>中断时间：{scenario.partial?.interruptedAt ? new Date(scenario.partial.interruptedAt).toLocaleTimeString() : '-'}</span>
      <button onClick={onCompute}>重新推演</button>
    </div>}
    {scenario.lastError && <div className="banner error"><b>{scenario.lastError.code}</b><span>{scenario.lastError.message}</span><button onClick={onCompute}>重试推演</button></div>}
    {scenario.status === 'expired' && <div className="banner error"><b>方案已过期</b><span>超过 15 分钟有效期，沙盘副本已失效，请基于当前生产状态重建。</span><button onClick={onRebuild}>重建方案</button></div>}
    {scenario.status === 'committed' && <div className="banner ok"><b>方案已提交生产</b><span>提交时间 {scenario.commit ? new Date(scenario.commit.committedAt).toLocaleString() : '—'}，提交后版本 v{scenario.commit?.version}</span></div>}
    {stale && scenario.status !== 'committed' && scenario.status !== 'expired' && <div className="banner warning">
      <b>基线已过期</b><span>推演期间生产状态从 v{scenario.baseVersion} 变化到 v{summary?.currentVersion}，直接提交会被乐观锁拒绝。</span>
      <button onClick={onRebuild}>基于当前生产重建</button>
    </div>}
    {conflict && <div className="banner conflict">
      <b>提交被拒绝：版本冲突</b><span>{conflict.message}</span>
      {conflict.detail && <div className="conflict-entities">
        <div className="tr th"><span>实体</span><span>ID</span><span>变化</span></div>
        {conflict.detail.changedEntities.map((c, i) => <div className="tr" key={`${c.entity}-${c.id}-${i}`}><span>{c.entity}</span><span>{c.id}</span><span>{c.type === 'created' ? '新增' : c.type === 'deleted' ? '删除' : '字段更新'}</span></div>)}
      </div>}
      <button onClick={onRebuild}>以相同假设重建</button><button onClick={onDiscard}>放弃方案</button>
    </div>}
    {commitInfo && scenario.status === 'committed' && <CommittedDiff info={commitInfo} />}

    {r && <>
      <div className="metric-grid">
        <Metric label="窗口时长" value={fmtMin(r.windowMinutes)} sub={`生产计划 ${fmtMin(r.windowBaselineMinutes)}`} basis={r.windowMinutes === r.windowBaselineMinutes ? 'production' : 'assumption'} />
        <Metric label="预计剩余 moves" value={String(r.remainingMoves)} sub={`生产基线 ${r.remainingMovesBaseline} · 提前装船 +${r.earlyMoves} · 移箱 +${r.relocationMoves}`} basis="assumption" />
        <Metric label="窗口内可完成" value={String(r.throughputMoves)} sub={`岸桥能力 ${r.equipmentCapacityMph} mph × 85% 利用率`} basis="assumption" />
        <Metric label="吞吐缺口" value={String(r.overrunMoves)} sub={r.overrunMoves === 0 ? '窗口内可完成全部作业' : '需要追加岸桥或继续延长窗口'} basis="assumption" tone={r.overrunMoves > 0 ? 'bad' : 'ok'} />
      </div>

      <div className="result-block">
        <div className="result-head"><h4>风险评估</h4><span className={`risk-pill ${r.lateRisk}`}>{riskLabel(r.lateRisk)} · {r.completable ? '方案可行' : '方案不可直接执行'}</span></div>
        {r.risks.map((risk, i) => <div key={`${risk.code}-${i}`} className={`risk-row ${risk.level}`}>
          <strong>{riskLabel(risk.level)}</strong><code>{risk.code}</code><span>{risk.message}</span><BasisTag basis={risk.basis} />
        </div>)}
      </div>

      <div className="result-block">
        <div className="result-head"><h4>区块容量复核</h4><span className="muted">流入/流出来自移箱假设</span></div>
        <div className="capacity-table">
          <div className="tr th"><span>区块</span><span>占用/容量</span><span>利用率</span><span>流转变动</span><span>余量</span><span>结论来源</span></div>
          {r.blockCapacities.map(line => <div className="tr" key={line.blockId}>
            <span><b>{line.blockId}</b></span>
            <span>{line.occupied} / {line.capacity}</span>
            <span>{Math.round(line.utilization * 100)}%</span>
            <span>{line.deltaIn ? <em className="in">+{line.deltaIn}</em> : '—'} / {line.deltaOut ? <em className="out">-{line.deltaOut}</em> : '—'}</span>
            <span className={line.feasible ? 'ok-text' : 'bad-text'}>{line.feasible ? `余 ${line.freeSlots}` : `超容 ${-line.freeSlots}`}</span>
            <span><BasisTag basis={line.basis} /></span>
          </div>)}
        </div>
      </div>

      <div className="result-block">
        <div className="result-head"><h4>受影响任务（{r.affectedTasks.length}）</h4><span className="muted">虚拟任务是假设新增，不会直接出现在生产队列</span></div>
        <div className="affected-table">
          <div className="tr th"><span>任务</span><span>箱号</span><span>路径</span><span>变化说明</span><span>状态</span><span>来源</span></div>
          {r.affectedTasks.map((t, i) => <div className="tr" key={`${t.taskId ?? t.containerId}-${i}`}>
            <span><b>{t.taskId ?? '（虚拟）'}</b><small>{t.kind}{t.scheduledShiftMin ? ` · 平移 ${t.scheduledShiftMin}min` : ''}</small></span>
            <span>{t.containerId}</span>
            <span>{t.from} → {t.to}</span>
            <span>{t.change}{t.blockingReasons[0] && <small className="blocked-text">{t.blockingReasons[0]}</small>}</span>
            <span>{t.status}</span>
            <span><BasisTag basis={t.basis} /></span>
          </div>)}
        </div>
      </div>

      <div className="result-block">
        <div className="result-head"><h4>本方案实际采用的假设（{r.assumptionsApplied.length}）</h4><BasisTag basis="assumption" /></div>
        <ul className="assumption-list">{r.assumptionsApplied.map((text, i) => <li key={i}>{text}</li>)}</ul>
        <p className="calc-note">结论于 {new Date(r.computedAt).toLocaleString()} 由隔离副本计算；除「生产现状」标记外，以上数字均为假设下的预估值，不代表当前生产状态。</p>
      </div>
    </>}

    <div className="detail-actions">
      {scenario.status !== 'committed' && scenario.status !== 'expired' && <>
        {scenario.status === 'computing'
          ? <button className="danger-action" onClick={onInterrupt}>中断推演</button>
          : <button onClick={onCompute}>{scenario.status === 'interrupted' ? '重新推演' : '重新计算'}</button>}
        <button className="primary-action" disabled={busy || !canCommit} onClick={onCommit}>{busy ? '提交校验中…' : '提交差异到生产'}</button>
        <button onClick={onDiscard}>放弃方案</button>
      </>}
      {!canCommit && scenario.status !== 'computing' && scenario.status !== 'committed' && scenario.status !== 'expired' && <small className="hint">只有完成推演（可提交/基线过期）后才能提交；中断与失败结论不允许提交。</small>}
    </div>
  </div>;
}

function Metric({ label, value, sub, basis, tone }: { label: string; value: string; sub: string; basis: Basis; tone?: 'ok'|'bad' }) {
  return <div className="metric-card">
    <small>{label}<BasisTag basis={basis} /></small>
    <b className={tone === 'bad' ? 'bad-text' : tone === 'ok' ? 'ok-text' : ''}>{value}</b>
    <span>{sub}</span>
  </div>;
}

function AssumptionSummary({ scenario }: { scenario: ScenarioDetail }) {
  const a = scenario.assumptions;
  return <div className="assumption-summary">
    <div><small>航次</small><b>{a.voyageId}</b></div>
    <div><small>ETA 假设</small><b>{a.eta ? new Date(a.eta).toLocaleString() : '沿用生产'}</b></div>
    <div><small>ETD 假设</small><b>{a.etd ? new Date(a.etd).toLocaleString() : '沿用生产'}</b></div>
    <div><small>提前装船</small><b>{a.earlyLoadContainerIds.length} 箱</b></div>
    <div><small>移箱</small><b>{a.relocations.length} 箱</b></div>
    <div><small>设备调整</small><b>{a.equipmentOverrides.length} 项</b></div>
    <div><small>容量调整</small><b>{a.capacityOverrides.length} 项</b></div>
  </div>;
}

function CommittedDiff({ info }: { info: CommitInfo }) {
  return <div className="result-block diff-block">
    <div className="result-head"><h4>已提交差异（{info.diff.length} 项）</h4><span className="muted">已写入生产 v{info.version}</span></div>
    {info.diff.map((d, i) => <div className="diff-row" key={`${d.entity}-${d.id}-${i}`}>
      <code>{d.action === 'create' ? '新增' : '更新'} · {d.entity}</code><b>{d.id}</b>
      {d.changes && Object.entries(d.changes).map(([key, change]) => <span key={key} className="change-pair">{key}: <em>{String(change.from)}</em> → <strong>{String(change.to)}</strong></span>)}
      {d.payload && <span className="change-pair">新任务 {String(d.payload.kind)} → {String(d.payload.to)}</span>}
      <BasisTag basis={d.basis} />
    </div>)}
  </div>;
}

/* ---------------- 创建方案表单 ---------------- */

function ScenarioForm({ voyages, containers, blocks, equipment, busy, onCreated, onCancel }: {
  voyages: Voyage[]; containers: Container[]; blocks: Block[]; equipment: Equipment[]; busy: boolean;
  onCreated: (id: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [voyageId, setVoyageId] = useState(voyages[0]?.id ?? '');
  const [eta, setEta] = useState('');
  const [etd, setEtd] = useState('');
  const [earlyIds, setEarlyIds] = useState<string[]>([]);
  const [relocs, setRelocs] = useState<{ containerId: string; toBlockId: string }[]>([]);
  const [equipRates, setEquipRates] = useState<Record<string, string>>({});
  const [blockCaps, setBlockCaps] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');

  const voyageContainers = useMemo(() => containers.filter(c => c.voyageId === voyageId), [containers, voyageId]);
  const chosenVoyage = voyages.find(v => v.id === voyageId);

  const toggleEarly = (id: string) => setEarlyIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const addReloc = () => setRelocs(prev => [...prev, { containerId: voyageContainers[0]?.id ?? containers[0]?.id ?? '', toBlockId: blocks[0]?.id ?? '' }]);

  const submit = async () => {
    setFormError('');
    const assumptions = {
      voyageId,
      ...(eta ? { eta: new Date(eta).toISOString() } : {}),
      ...(etd ? { etd: new Date(etd).toISOString() } : {}),
      earlyLoadContainerIds: earlyIds,
      relocations: relocs.filter(r => r.containerId && r.toBlockId),
      equipmentOverrides: Object.entries(equipRates).filter(([, v]) => v !== '').map(([equipmentId, movesPerHour]) => ({ equipmentId, movesPerHour: Number(movesPerHour) })),
      capacityOverrides: Object.entries(blockCaps).filter(([, v]) => v !== '').map(([blockId, capacity]) => ({ blockId, capacity: Number(capacity) })),
    };
    try {
      const created = await request<ScenarioDetail>('/scenarios', { method: 'POST', body: JSON.stringify({ name: name || undefined, assumptions }) });
      onCreated(created.id);
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : '创建失败'); }
  };

  return <div className="scenario-form">
    <div className="form-grid">
      <label>方案名称<input placeholder="例如：窗口压缩 90 分钟 + 提前装船" value={name} onChange={e => setName(e.target.value)} /></label>
      <label>目标航次<select value={voyageId} onChange={e => { setVoyageId(e.target.value); setEarlyIds([]); setRelocs([]); }}>
        {voyages.map(v => <option key={v.id} value={v.id}>{v.id} · {v.vessel}（{v.berth}）</option>)}
      </select></label>
      <label>ETA 假设（留空=沿用生产）<input type="datetime-local" value={eta} placeholder={chosenVoyage ? toLocalInput(chosenVoyage.eta) : ''} onChange={e => setEta(e.target.value)} /></label>
      <label>ETD 假设（留空=沿用生产）<input type="datetime-local" value={etd} placeholder={chosenVoyage ? toLocalInput(chosenVoyage.etd) : ''} onChange={e => setEtd(e.target.value)} /></label>
    </div>

    <div className="form-section">
      <div className="form-section-head"><b>提前装船目标箱集</b><BasisTag basis="assumption" /><span className="muted">勾选后在沙盘中为每箱新增一条装船任务（+1 move）；已装船箱会被自动剔除</span></div>
      <div className="checkbox-grid">
        {voyageContainers.map(c => <label key={c.id} className={`check-box ${earlyIds.includes(c.id) ? 'checked' : ''}`}>
          <input type="checkbox" checked={earlyIds.includes(c.id)} onChange={() => toggleEarly(c.id)} />
          <span><b>{c.id}</b><small>{c.status} · {c.yardSlot}{c.reefer ? ' · 冷藏' : ''}{c.hazmatClass ? ` · 危 ${c.hazmatClass}` : ''}</small></span>
        </label>)}
        {voyageContainers.length === 0 && <small className="muted">该航次暂无箱务记录</small>}
      </div>
    </div>

    <div className="form-section">
      <div className="form-section-head"><b>移箱到更近区块</b><BasisTag basis="assumption" /><button type="button" onClick={addReloc}>＋ 添加移箱</button></div>
      {relocs.map((reloc, index) => <div className="reloc-row" key={index}>
        <select value={reloc.containerId} onChange={e => setRelocs(prev => prev.map((x, i) => i === index ? { ...x, containerId: e.target.value } : x))}>
          {containers.map(c => <option key={c.id} value={c.id}>{c.id}（现 {c.yardSlot}）</option>)}
        </select>
        <span>→</span>
        <select value={reloc.toBlockId} onChange={e => setRelocs(prev => prev.map((x, i) => i === index ? { ...x, toBlockId: e.target.value } : x))}>
          {blocks.map(b => <option key={b.id} value={b.id}>{b.id} · {b.zone}（余 {b.capacity - b.occupied}{b.hazmatAllowed ? ' · 危' : ''}{b.reeferPlugs - b.usedPlugs ? ` · 冷插${b.reeferPlugs - b.usedPlugs}` : ''}）</option>)}
        </select>
        <button type="button" className="danger-action" onClick={() => setRelocs(prev => prev.filter((_, i) => i !== index))}>移除</button>
      </div>)}
    </div>

    <div className="form-section">
      <div className="form-section-head"><b>设备能力假设（moves/hour）</b><BasisTag basis="assumption" /></div>
      <div className="override-grid">
        {equipment.filter(e => e.kind === 'quay-crane' || e.kind === 'yard-crane').map(e => <label key={e.id}>{e.name}（生产 {e.movesPerHour}）
          <input type="number" min="0" placeholder="留空=不变" value={equipRates[e.id] ?? ''} onChange={ev => setEquipRates(prev => ({ ...prev, [e.id]: ev.target.value }))} />
        </label>)}
      </div>
    </div>

    <div className="form-section">
      <div className="form-section-head"><b>区块容量假设</b><BasisTag basis="assumption" /><span className="muted">仅调整容量上限，占用随移箱假设自动流转</span></div>
      <div className="override-grid">
        {blocks.map(b => <label key={b.id}>{b.id}（生产 {b.occupied}/{b.capacity}）
          <input type="number" min="0" placeholder="容量留空=不变" value={blockCaps[b.id] ?? ''} onChange={ev => setBlockCaps(prev => ({ ...prev, [b.id]: ev.target.value }))} />
        </label>)}
      </div>
    </div>

    {formError && <div className="form-error">{formError}</div>}
    <div className="modal-actions"><button type="button" onClick={onCancel}>取消</button><button type="button" className="primary-action" disabled={busy || !voyageId} onClick={() => void submit()}>创建隔离副本并推演</button></div>
  </div>;
}
