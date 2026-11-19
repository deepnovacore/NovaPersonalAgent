import {PermissionCards} from '../windows/welcome';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FilePlus2, FolderPlus, Monitor, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { Action, Card, Field, useCommand } from './controls';
import { t } from '../../locale.mjs';
import { DEFAULT_SKIN, MAX_SKIN_BYTES, importSkin, removeSkin, selectedSkin } from '../../orb-skins.mjs';
import { createSkinVisual } from '../../orb-skin-visual.mjs';
import { readDisplayPreferences, writeDisplayPreferences, subscribeDisplayPreferences } from '../../view-preferences.mjs';
const DISPLAY_OPTIONS: any = {
    'display-steps': { key: 'steps', label: '工作步骤展示', options: [['compact', '简洁'], ['standard', '标准'], ['detailed', '详细']] },
    'display-collapse': { key: 'collapse', label: '工作步骤收起时机', options: [['after_reply', '回答结束后'], ['manual', '手动']] },
};
/** Only the select is replaced; its label and hint stay in the page's own `.field` wrapper so the row lays out like every other setting. */
export function DisplayPanel({ id }: { id: string }) { const [p, setP] = useState(readDisplayPreferences); useEffect(() => subscribeDisplayPreferences(setP), []); const spec = DISPLAY_OPTIONS[id]; return <select id={id} aria-label={t(spec.label)} value={(p as any)[spec.key]} onChange={e => writeDisplayPreferences({ [spec.key]: e.target.value })}>{spec.options.map(([value, label]: string[]) => <option key={value} value={value}>{t(label)}</option>)}</select>; }
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
/**
 * Knowledge sources keep the ids and commands the main process already binds
 * (#knowledge-files / -folder / -refresh / -add-url). The page is a toolbar,
 * a URL row and a compact source list instead of stacked bare buttons.
 */
export function KnowledgePanel({ api, view }: any) {
    const enabled = view.capabilities?.runtime?.modules?.knowledge?.enabled === true;
    const [state, setState] = useState<any>({}), [url, setUrl] = useState(''), [note, setNote] = useState(t('点击刷新查看知识库。')), [tone, setTone] = useState('info'), [busy, setBusy] = useState(false), [confirmRemove, setConfirmRemove] = useState<string | null>(null);
    const epoch = useRef(0), lock = useRef(false);
    // Capture the new configuration before the toolbar can dispatch its first request.
    useLayoutEffect(() => {
        epoch.current++;
        setConfirmRemove(null);
        setState({});
        setNote(t('点击刷新查看知识库。'));
        setTone('info');
        return () => { epoch.current++; };
    }, [enabled, view.embeddingProvider, view.embeddingModel]);
    async function run(input: any) {
        if (!enabled || lock.current)
            return;
        const rev = epoch.current;
        lock.current = true;
        setConfirmRemove(null);
        let ok = false;
        setBusy(true);
        setNote(t('处理中…'));
        setTone('busy');
        try {
            if (['files', 'folder', 'url', 'reindex'].includes(input.action))
                input = { ...input, consent: true };
            const result = await api.knowledgeAction(input);
            if (result?.error)
                throw Error();
            const next = input.action === 'status' ? result : await api.knowledgeAction({ action: 'status' });
            if (next?.error)
                throw Error();
            ok = true;
            if (rev === epoch.current) {
                setState(next);
                const failures = (next.jobs ?? []).filter((job: any) => job.state === 'failed').length;
                setNote(t('{0} 个来源{1}{2}', next.sources?.length ?? 0, next.fts === false ? t('；FTS5 不可用，已使用基础词法匹配（无相关性排序）。') : next.fts === true ? t('；FTS5 已启用。') : '', failures ? t('；{0} 个失败任务，请检查文件格式、敏感内容或服务连接后重试。', failures) : ''));
                setTone(failures ? 'warn' : 'info');
            }
        }
        catch {
            if (rev === epoch.current) {
                setNote(t('知识库操作失败；请确认模块已启用、后端正在运行，或检查文档与服务连接。'));
                setTone('error');
            }
        }
        finally {
            lock.current = false;
            setBusy(false);
        }
        return ok;
    }
    const sources: any[] = (state.sources ?? []).slice(0, 100);
    return <div id="knowledge-panel" hidden={!enabled} aria-busy={busy}>
        <p className="hint">{t('支持文本、Markdown、代码、PDF、DOCX，单文件最多 10 MB。更换模型后需重建来源。')}</p>
        <div className="knowledge-actions" role="toolbar" aria-label={t('知识库操作')}>
            <Action id="knowledge-files" className="knowledge-action soft" disabled={!enabled || busy} action={() => run({ action: 'files' })}><FilePlus2 size={16} aria-hidden="true"/><span>{t('添加文件')}</span></Action>
            <Action id="knowledge-folder" className="knowledge-action soft" disabled={!enabled || busy} action={() => run({ action: 'folder' })}><FolderPlus size={16} aria-hidden="true"/><span>{t('添加文件夹')}</span></Action>
            <Action id="knowledge-refresh" className="knowledge-action ghost" disabled={!enabled || busy} action={() => run({ action: 'status' })}><RefreshCw size={16} aria-hidden="true"/><span>{t('刷新')}</span></Action>
        </div>
        <div className="knowledge-url">
            <input id="knowledge-url" type="url" maxLength={2048} aria-label={t('公开网页 URL')} placeholder={t('粘贴网页链接')} value={url} disabled={!enabled || busy} onChange={(event: any) => setUrl(event.target.value)}/>
            <Action id="knowledge-add-url" className="knowledge-action" disabled={!enabled || busy || !url.trim()} action={async () => { if (await run({ action: 'url', url })) setUrl(''); }}>{t('导入网页')}</Action>
        </div>
        <p id="knowledge-status" className="knowledge-status" role="status" aria-live="polite" data-tone={tone}>{note}</p>
        {sources.length ? <ul id="knowledge-sources">
            {sources.map((source: any) => {
                const status = source.status === 'ready' ? 'ready' : source.status === 'failed' ? 'failed' : 'unknown';
                return <li className="knowledge-source" key={source.id}>
                    <div className="knowledge-source-copy">
                        <span className="knowledge-source-title">{source.title}</span>
                        <span className="knowledge-source-state" data-state={status}>{t(status === 'ready' ? '就绪' : status === 'failed' ? '失败' : '处理中')}</span>
                    </div>
                    <div className="knowledge-source-actions">
                        <Action className="knowledge-source-action" aria-label={`${t('重建索引')} ${source.title}`} title={t('重建索引')} disabled={busy} action={() => run({ action: 'reindex', id: source.id })}><RotateCcw size={15} aria-hidden="true"/></Action>
                        <Action className="knowledge-source-action destructive" data-armed={confirmRemove === source.id ? 'true' : undefined} aria-label={`${confirmRemove === source.id ? t('确认移除') : t('移除')} ${source.title}`} title={confirmRemove === source.id ? t('再点一次确认移除') : t('移除')} disabled={busy} action={async () => { if (confirmRemove !== source.id) { setConfirmRemove(source.id); return; } setConfirmRemove(null); await run({ action: 'remove', id: source.id }); }}><Trash2 size={15} aria-hidden="true"/></Action>
                    </div>
                </li>;
            })}
        </ul> : Array.isArray(state.sources) ? <p className="knowledge-empty">{t('还没有添加来源。')}</p> : null}
    </div>;
}
