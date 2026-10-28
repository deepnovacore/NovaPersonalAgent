import React, { useEffect, useRef, useState } from 'react';
import { Action, Card, Field, useCommand } from './controls';
import { t } from '../../locale.mjs';
import { DEFAULT_SKIN, MAX_SKIN_BYTES, importSkin, removeSkin, selectedSkin } from '../../orb-skins.mjs';
import { createSkinVisual } from '../../orb-skin-visual.mjs';
import { frontendUsageText, usageCostText, usageFeatureLabels } from '../../frontend-usage.mjs';
import { readDisplayPreferences, writeDisplayPreferences, subscribeDisplayPreferences } from '../../view-preferences.mjs';
export function DisplayPanel() { const [p, setP] = useState(readDisplayPreferences); useEffect(() => subscribeDisplayPreferences(setP), []); return <><Field label="工作步骤展示" value={p.steps} options={[{ value: 'compact', label: '简洁' }, { value: 'standard', label: '标准' }, { value: 'detailed', label: '详细' }]} onChange={(steps: string) => writeDisplayPreferences({ steps })}/><Field label="工作步骤收起时机" value={p.collapse} options={[{ value: 'after_reply', label: '回答结束后' }, { value: 'manual', label: '手动' }]} onChange={(collapse: string) => writeDisplayPreferences({ collapse })}/></>; }
export function VisorPanel({ api }: any) { const [p, setP] = useState<any>({}), [busy, setBusy] = useState(false), [status, setStatus] = useState(''); const lock = useRef(false); useEffect(() => { if (!api)
    return; let live = true; const refresh = () => { if (!lock.current)
    void api.snapshot().then((v: any) => { if (live)
        setP(v.preferences); }).catch(() => { if (live)
        setStatus(t('无法读取 Visor 设置')); }); }; refresh(); window.addEventListener('focus', refresh); return () => { live = false; window.removeEventListener('focus', refresh); }; }, [api]); const change = async (key: string, value: any) => { if (lock.current)
    return; lock.current = true; setBusy(true); try {
    setP(await api.configure({ [key]: value }));
    setStatus(t('已即时保存'));
}
catch {
    setStatus(t('保存失败，请重试'));
}
finally {
    lock.current = false;
    setBusy(false);
} }; return <section className="setting-section" id="visor-section"><h2>Nova Visor · {t('桌面驾驶舱')}</h2>{[['enabled', '启用桌面 HUD'], ['mode', '显示模式'], ['opacity', '界面亮度 / 不透明度'], ['motion', '动态效果（跟随系统的减弱动态设置）'], ['hardware', '显示电脑硬件数据'], ['ai', '显示 Nova 状态与用量']].map(([k, label]) => <Field key={k} id={'visor-' + k} label={label} value={p[k]} type={k === 'opacity' ? 'range' : k === 'mode' ? 'text' : 'checkbox'} options={k === 'mode' ? [{ value: 'focus', label: '专注 · 低动态' }, { value: 'showcase', label: '展示 · 完整动画' }] : undefined} min={k === 'opacity' ? 0.3 : undefined} max={1} step={0.05} disabled={busy || !api} onChange={(v: any) => void change(k, v)}/>)}<p className="hint">{t('修改即时生效。⌘ / Ctrl + Shift + J 展开或收起。')}</p><p role="status">{status}</p></section>; }
export function SkinPanel({ view, stage, discard, busy }: any) { const canvas = useRef<HTMLCanvasElement>(null), visual = useRef<any>(null), alive = useRef(true); const [reading, setReading] = useState(false), [status, setStatus] = useState(''); useEffect(() => { alive.current = true; try {
    visual.current = createSkinVisual(canvas.current, { reducedMotion: true, staticPreview: true });
    visual.current.setState('idle');
    visual.current.setSkin(view);
}
catch { /* Canvas may not be available in a renderer test. */ } return () => { alive.current = false; visual.current?.destroy(); }; }, []); useEffect(() => { visual.current?.setSkin(view); }, [view]); return <section className="setting-section" id="orb-skin-section"><h2>{t('悬浮球皮肤')}</h2><div className="skin-layout"><canvas ref={canvas} id="orb-skin-preview" width={116} height={116} role="img" aria-label={t('所选皮肤静态预览')}/><div className="skin-controls"><Field label="当前皮肤" value={selectedSkin(view).id} options={[DEFAULT_SKIN, ...(view.importedSkins ?? [])].map((s: any) => ({ value: s.id, label: s.name }))} disabled={busy || reading} onChange={(skinId: string) => stage({ skinId })}/><label>{t('导入皮肤')}<input id="orb-skin-file" type="file" accept=".json,application/json" disabled={busy || reading} onChange={async (e) => { const file = e.target.files?.[0], input = e.target; if (!file)
    return; setReading(true); try {
    if (file.size > MAX_SKIN_BYTES)
        throw Error('skin_size');
    const text = await file.text();
    if (alive.current) {
        stage(importSkin(view, text));
        setStatus(t('已导入并选中，保存后生效。'));
    }
}
catch (e: any) {
    if (alive.current)
        setStatus(t(({ skin_size: '皮肤文件不能超过 8 KB。', skin_duplicate: '此皮肤已存在，请先移除旧版本。', skin_limit: '最多保存 16 个导入皮肤。', skin_version: '不支持此皮肤版本。' } as any)[e.message] ?? '皮肤文件无效或使用了不支持的参数。'));
}
finally {
    input.value = '';
    if (alive.current)
        setReading(false);
} }}/></label><Action disabled={busy || reading || selectedSkin(view).id === 'nova'} action={() => { stage(removeSkin(view, selectedSkin(view).id)); setStatus(t('已移除，保存后生效。')); }}>{t('移除所选皮肤')}</Action><Action disabled={busy || reading} action={() => { discard(['skinId', 'importedSkins']); setStatus(''); }}>{t('放弃皮肤修改')}</Action></div></div><p className="hint">{t('选择或导入皮肤后点击保存即可应用。')}</p><p role="status">{status}</p></section>; }
export function PermissionsPanel({ api }: any) { const [p, setP] = useState<any>({}); useEffect(() => { if (!api)
    return; let alive = true; const update = (v: any) => { if (alive)
    setP(v.permissions ?? {}); }; const refresh = () => void api.get().then(update).catch(() => { }); const off = api.onChanged?.(update); refresh(); window.addEventListener('focus', refresh); return () => { alive = false; off?.(); window.removeEventListener('focus', refresh); }; }, [api]); const labels: any = { granted: '已授权', denied: '未授权', restricted: '受系统限制', 'not-determined': '尚未设置', unknown: '暂时无法确认', not_required: '无需此系统授权', unsupported: '当前系统不支持' }; return <>{[['microphone', '麦克风', '用于语音对话；不授权也可以打字聊天。'], ['screen', '屏幕录制', '用于查看电脑画面。使用电脑操作时，截图会发送给所用的视觉模型。'], ['accessibility', '辅助功能', '用于点击、输入和滚动。电脑操作仍需在 Nova 内逐次批准。']].map(([k, title, description]) => <article key={k} className="permission-row"><div className="permission-copy"><h3>{t(title)}</h3><p>{t(description)}</p></div><div className="permission-aside"><span className="permission-state">{t(labels[p[k]] ?? labels.unknown)}</span>{!['granted', 'not_required', 'unsupported'].includes(p[k]) && <Action disabled={!api} aria-label={t('设置{0}权限', t(title))} action={async () => setP((await api.permission(k)).permissions)}>{t('去设置')}</Action>}</div></article>)}<Action disabled={!api} action={async () => setP((await api.get()).permissions)}>{t('重新检查权限')}</Action><p className="permission-note">{t(['granted', 'not_required'].includes(p.screen) && ['granted', 'not_required'].includes(p.accessibility) ? '系统权限已就绪。在 Build 中打开 Computer Use 即可使用，执行前仍会请求批准。' : '授权后可在 Build 中使用电脑操作；默认使用主屏幕和当前对话模型。')}</p></>; }
export function UsagePanel({ usage }: any) { const [scope, setScope] = useState('session'), [group, setGroup] = useState('features'); const value = (scope === 'history' ? usage?.history : usage) ?? {}, rows = group === 'features' ? (value.features ?? value.rows) : group === 'runs' ? value.runs : value.rows; return <section className="setting-section" id="frontend-usage-section"><h2>{t('用量与费用')}</h2><div className="usage-overview">{['history', 'session'].map(s => { const v = (s === 'history' ? usage?.history : usage) ?? {}; return <button key={s} className="usage-scope" type="button" aria-pressed={scope === s} onClick={() => setScope(s)}><span>{t(s === 'history' ? '历史累计' : '本次运行')}</span><strong>{v.requests && !v.unavailable ? usageCostText(v) : '—'}</strong><span>{v.unavailable ? t('读取失败') : t('{0} 次调用', v.requests ?? 0)}</span></button>; })}</div><p role="status">{usage?.persistenceError ? t('历史用量读取或保存失败，当前用量仍保留。') : value.requests ? frontendUsageText({ ...value, rows: [] }).split('\n\n').slice(0, 2).join(' · ') : t('模型调用后显示用量')}</p><p className="usage-note">{t('包含对话与后台任务，费用为估算值。')}</p><p className="usage-note">{t('部分外部工具的用量可能未计入。')}</p><Field label="统计维度" value={group} options={[{ value: 'features', label: '按功能' }, { value: 'models', label: '按模型' }, { value: 'runs', label: '按任务运行（最近 100 组）' }]} onChange={setGroup}/>{value.requests > 0 && <details open><summary>{t('用量明细')}</summary><div className="usage-stats">{[['requests', '调用次数'], ['missingReports', '缺少用量'], ['unpricedReports', '无法估价'], ['failedRequests', '失败调用'], ['cancelledRequests', '取消调用']].map(([key, label]) => <div className="usage-metric" key={key}><span>{t(label)}</span><strong>{value[key] ?? 0}</strong></div>)}</div>{(rows ?? []).map((row: any, i: number) => <article className="usage-card" key={i}><strong>{group === 'models' ? `${row.service} · ${row.provider}` : usageFeatureLabels[row.feature] ?? t('未分类')}</strong><p>{row.model ?? row.runId ?? row.taskId ?? t('按功能汇总所有模型')}</p><strong>{row.pricedReports ? usageCostText(row) : t('暂无数据')}</strong><div className="usage-grid">{Object.entries(row).filter(([k, v]) => typeof v === 'number' && !k.startsWith('cost')).map(([k, v]) => <div key={k} className="usage-metric"><span>{t(({ inputTokens: '输入词元', outputTokens: '输出词元', requests: '调用次数', durationMs: '耗时 ms', audioDurationMs: '音频时长 ms', failedRequests: '失败调用', cancelledRequests: '取消调用' } as any)[k] ?? k)}</span><strong>{String(v)}</strong></div>)}</div></article>)}{!!value.recent?.length && <details><summary>{t('最近 {0} 次调用', value.recent.length)}</summary>{[...value.recent].reverse().map((call: any, i: number) => <article className="usage-call" key={i}><strong>{usageFeatureLabels[call.feature] ?? call.feature} · {call.operation ?? call.service} · {t(({ success: '成功', error: '失败', cancelled: '已取消' } as any)[call.outcome] ?? '未知')}</strong><p>{call.model} · {call.timestamp ? new Date(call.timestamp).toLocaleString() : ''}</p><p>{t('输入词元')} {call.inputTokens ?? '—'} · {t('输出词元')} {call.outputTokens ?? '—'} · {call.durationMs ?? '—'} ms</p></article>)}</details>}</details>}</section>; }
export function SkillsPanel({ skills, api }: any) { const [query, setQuery] = useState(''), [list, setList] = useState(skills), [error, setError] = useState(''); useEffect(() => setList(skills), [skills]); return <><p className="hint">{t('~/.nova-personal-agent/skills 下的技能')}</p><Field label="搜索技能" value={query} onChange={setQuery}/><Action action={async () => { try {
    const v = await api.get();
    setList(v.skills);
    setError('');
}
catch {
    setError(t('暂时无法读取技能，请稍后刷新。'));
} }}>{t('刷新')}</Action><p role="status">{error}</p>{!Array.isArray(list) ? <p>{t('暂时无法读取技能，请稍后刷新。')}</p> : list.filter((s: any) => JSON.stringify(s).toLowerCase().includes(query.toLowerCase())).map((s: any, i: number) => <Card key={s.name ?? i} title={s.name ?? s.title ?? 'Skill'} description={s.description}><span className="skill-state" data-state={s.id==='computer-use'?'session':'on'}>{t(s.id==='computer-use'?'按会话':'已启用')}</span><p>{s.source ?? s.path}</p>{s.error && <p role="alert">{s.error}</p>}</Card>)}</>; }
export function KnowledgePanel({ api, view }: any) { const enabled = view.capabilities?.runtime?.modules?.knowledge?.enabled === true; const [state, setState] = useState<any>({}), [url, setUrl] = useState(''), [note, setNote] = useState(t('点击刷新查看知识库。')); const epoch = useRef(0), lock = useRef(false); useEffect(() => { epoch.current++; setState({}); setNote(t('点击刷新查看知识库。')); return () => { epoch.current++; }; }, [enabled, view.embeddingProvider, view.embeddingModel, view.modelBaseUrl]); async function run(input: any) { if (!enabled || lock.current)
    return; const rev = epoch.current; lock.current = true; setNote(t('处理中…')); try {
    if (['files', 'folder', 'url', 'reindex'].includes(input.action))
        input = { ...input, consent: true };
    const result = await api.knowledgeAction(input);
    if (result?.error)
        throw Error();
    const next = input.action === 'status' ? result : await api.knowledgeAction({ action: 'status' });
    if (next?.error)
        throw Error();
    if (rev === epoch.current) {
        setState(next);
        setNote(t('{0} 个来源', next.sources?.length ?? 0) + (next.fts === false ? t('；FTS5 不可用，已使用基础词法匹配（无相关性排序）。') : next.fts === true ? t('；FTS5 已启用。') : '') + ((next.jobs ?? []).some((j: any) => j.state === 'failed') ? t('；有失败任务，请检查文件格式、敏感内容或服务连接后重试。') : ''));
    }
}
catch {
    if (rev === epoch.current)
        setNote(t('知识库操作失败；请确认模块已启用、后端正在运行，或检查文档与服务连接。'));
}
finally {
    lock.current = false;
} } return <div id="knowledge-panel" hidden={!enabled}><p>{t('支持文本、Markdown、代码、PDF、DOCX，单文件最多 10 MB。更换模型后需重建来源。')}</p>{[['files', '添加文件'], ['folder', '添加文件夹'], ['status', '刷新']].map(([action, label]) => <Action key={action} disabled={!enabled} action={() => run({ action })}>{t(label)}</Action>)}<Field label="公开网页 URL" type="url" value={url} maxLength={2048} onChange={setUrl}/><Action disabled={!enabled} action={() => run({ action: 'url', url })}>{t('导入网页')}</Action><p role="status">{note}</p><ul>{(state.sources ?? []).slice(0, 100).map((s: any) => <li key={s.id}>{s.title} · {s.status}{[['reindex', '重建索引'], ['remove', '移除']].map(([action, label]) => <Action key={action} action={() => run({ action, id: s.id })}>{t(label)}</Action>)}</li>)}</ul></div>; }
