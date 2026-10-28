import {PermissionCards} from '../windows/welcome';
import React, { useEffect, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import { Action, Card, Field, useCommand } from './controls';
import { t } from '../../locale.mjs';
import { DEFAULT_SKIN, MAX_SKIN_BYTES, importSkin, removeSkin, selectedSkin } from '../../orb-skins.mjs';
import { createSkinVisual } from '../../orb-skin-visual.mjs';
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
catch { /* Canvas may not be available in a renderer test. */ } return () => { alive.current = false; visual.current?.destroy(); }; }, []); useEffect(() => { visual.current?.setSkin(view); }, [view]); return <section className="setting-section" id="orb-skin-section"><h2>{t('形象与皮肤')}</h2><Field label="形象" value={view.companionForm ?? 'pet'} options={[{ value: 'pet', label: '小宠物' }, { value: 'orb', label: '悬浮球' }]} disabled={busy} onChange={(companionForm: string) => stage({ companionForm })}/><p className="hint">{t(view.companionForm === 'pet' ? '小宠物使用「关于我」里的头像；切换为悬浮球后可选择皮肤。' : '悬浮球使用下面的皮肤与配色。')}</p><div className="skin-layout" hidden={view.companionForm === 'pet'}><canvas ref={canvas} id="orb-skin-preview" width={116} height={116} role="img" aria-label={t('所选皮肤静态预览')}/><div className="skin-controls"><Field label="当前皮肤" value={selectedSkin(view).id} options={[DEFAULT_SKIN, ...(view.importedSkins ?? [])].map((s: any) => ({ value: s.id, label: s.name }))} disabled={busy || reading} onChange={(skinId: string) => stage({ skinId })}/><label>{t('导入皮肤')}<input id="orb-skin-file" type="file" accept=".json,application/json" disabled={busy || reading} onChange={async (e) => { const file = e.target.files?.[0], input = e.target; if (!file)
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
    setP(v.permissions ?? {}); }; const refresh = () => void api.get().then(update).catch(() => { }); const off = api.onChanged?.(update); refresh(); window.addEventListener('focus', refresh); return () => { alive = false; off?.(); window.removeEventListener('focus', refresh); }; }, [api]); return api?<PermissionCards api={api} value={p} onChange={(value:any)=>setP(value.permissions??{})}/>:<p>{t('暂时无法读取系统权限。')}</p>; }

export { UsagePanel } from './usage';
export function SkillsPanel({ skills, api }: any) { const [query, setQuery] = useState(''), [list, setList] = useState(skills), [error, setError] = useState(''); useEffect(() => setList(skills), [skills]); return <><p className="hint">{t('~/.nova-personal-agent/skills 下的技能')}</p><Field label="搜索技能" value={query} onChange={setQuery}/><Action action={async () => { try {
    const v = await api.get();
    setList(v.skills);
    setError('');
}
catch {
    setError(t('暂时无法读取技能，请稍后刷新。'));
} }}>{t('刷新')}</Action><p role="status">{error}</p>{!Array.isArray(list) ? <p>{t('暂时无法读取技能，请稍后刷新。')}</p> : list.filter((s: any) => JSON.stringify(s).toLowerCase().includes(query.toLowerCase())).map((s: any, i: number) => <Card key={s.name ?? i} icon={s.id === 'computer-use' ? Monitor : undefined} title={s.name ?? s.title ?? 'Skill'} description={s.description}><span className="skill-state" data-state={s.id==='computer-use'?'session':'on'}>{t(s.id==='computer-use'?'按会话':'已启用')}</span><p>{s.source ?? s.path}</p>{s.error && <p role="alert">{s.error}</p>}</Card>)}</>; }
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
