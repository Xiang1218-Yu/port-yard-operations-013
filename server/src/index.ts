import express from 'express';
import { appointments, assignTask, blocks, containerDetail, containers, createContainer, createGateAppointment, createYardTask, dashboard, deleteContainer, deleteGateAppointment, deleteYardTask, editGateAppointment, equipment, gateConflicts, prioritizeTasks, tasks, updateContainer, updateYardTask, voyages, yardHeatmap } from './domain.js';
import { commitScenario, computeScenario, createScenario, deleteScenario, getScenario, interruptScenario, listScenarios, updateAssumptions, ScenarioError } from './scenarios.js';

const scenarioError = (res: express.Response, error: unknown) => {
  if (error instanceof ScenarioError) return res.status(error.status).json({ message: error.message, code: error.code, details: error.details });
  return res.status(500).json({ message: error instanceof Error ? error.message : '推演操作失败', code: 'SCENARIO_ERROR' });
};

const app = express(); app.use(express.json());
app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/voyages', (_req, res) => res.json(voyages));
app.get('/api/containers', (req, res) => res.json(req.query.status ? containers.filter(c => c.status === req.query.status) : containers));
app.post('/api/containers', (req, res) => { try { res.status(201).json(createContainer(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建箱务记录失败' }); } });
app.patch('/api/containers/:id', (req, res) => { try { const result = updateContainer(req.params.id, req.body); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新箱务记录失败' }); } });
app.delete('/api/containers/:id', (req, res) => { const result = deleteContainer(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/containers/:id', (req, res) => { const result = containerDetail(req.params.id); if (!result) return res.status(404).json({ message: '箱号不存在' }); res.json(result); });
app.get('/api/yard/heatmap', (_req, res) => res.json(yardHeatmap()));
app.get('/api/yard/blocks', (_req, res) => res.json(blocks));
app.get('/api/gate/appointments', (_req, res) => res.json(appointments));
app.get('/api/gate/conflicts', (_req, res) => res.json(gateConflicts()));
app.post('/api/gate/appointments', (req, res) => { try { res.status(201).json(createGateAppointment(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '预约失败' }); } });
app.patch('/api/gate/appointments/:id', (req, res) => { try { const result = editGateAppointment(req.params.id, req.body); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新预约失败' }); } });
app.delete('/api/gate/appointments/:id', (req, res) => { const result = deleteGateAppointment(req.params.id); if (!result) return res.status(404).json({ message: '预约不存在' }); res.json({ deleted: true, id: result.id }); });
app.get('/api/equipment', (_req, res) => res.json(equipment));
app.get('/api/tasks', (_req, res) => res.json(prioritizeTasks()));
app.post('/api/tasks', (req, res) => { try { res.status(201).json(createYardTask(req.body)); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '创建作业任务失败' }); } });
app.patch('/api/tasks/:id', (req, res) => { try { const result = updateYardTask(req.params.id, req.body); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json(result); } catch (error) { res.status(409).json({ message: error instanceof Error ? error.message : '更新作业任务失败' }); } });
app.delete('/api/tasks/:id', (req, res) => { const result = deleteYardTask(req.params.id); if (!result) return res.status(404).json({ message: '作业任务不存在' }); res.json({ deleted: true, id: result.id }); });
app.patch('/api/tasks/:id/assign', (req, res) => { const result = assignTask(req.params.id, req.body.equipmentId); if (!result) return res.status(404).json({ message: '任务或设备不存在' }); res.json(result); });

/* ---------------- 航次作业情景推演（隔离沙盘） ---------------- */
app.get('/api/scenarios', (_req, res) => res.json(listScenarios()));
app.post('/api/scenarios', (req, res) => {
  try { res.status(201).json(createScenario({ name: req.body?.name, assumptions: req.body?.assumptions ?? {}, ttlMs: req.body?.ttlMs })); }
  catch (error) { return scenarioError(res, error); }
});
app.get('/api/scenarios/:id', (req, res) => { try { res.json(getScenario(req.params.id)); } catch (error) { return scenarioError(res, error); } });
app.patch('/api/scenarios/:id', (req, res) => { try { res.json(updateAssumptions(req.params.id, req.body?.assumptions ?? req.body ?? {})); } catch (error) { return scenarioError(res, error); } });
app.delete('/api/scenarios/:id', (req, res) => { try { res.json(deleteScenario(req.params.id)); } catch (error) { return scenarioError(res, error); } });
app.post('/api/scenarios/:id/compute', async (req, res) => {
  const id = req.params.id;
  let scenario;
  try { scenario = getScenario(id); } catch (error) { return scenarioError(res, error); }
  if (scenario.status === 'committed' || scenario.status === 'expired')
    return scenarioError(res, new ScenarioError(409, `SCENARIO_${scenario.status.toUpperCase()}`, `方案已${scenario.status === 'committed' ? '提交' : '过期'}，不能推演`));
  // 立即返回 202，推演在后台进行，前端轮询 /api/scenarios/:id 获取结果（含 lastError）
  void computeScenario(id).catch(() => undefined);
  res.status(202).json({ id, status: 'computing', message: '推演已在隔离副本上启动' });
});
app.post('/api/scenarios/:id/interrupt', (req, res) => { try { res.json(interruptScenario(req.params.id)); } catch (error) { return scenarioError(res, error); } });
app.post('/api/scenarios/:id/commit', async (req, res) => {
  try { const result = await commitScenario(req.params.id, req.body?.actor); res.json(result); }
  catch (error) { return scenarioError(res, error); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'port-yard-operations' }));
const port = Number(process.env.PORT || 4107); app.listen(port, () => console.log(`port yard API listening on ${port}`));
