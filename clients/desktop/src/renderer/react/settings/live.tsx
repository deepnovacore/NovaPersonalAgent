import React, { useEffect, useRef, useState } from 'react';
import { Action, Card, Field, useCommand } from './controls';
import { t } from '../../locale.mjs';

const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const BRIEF_SLOTS: any[] = [['briefing_outlook', '早间简报', '早间时间', '08:30'], ['briefing_review', '晚间简报', '晚间时间', '18:30']];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * Diary and briefing rows. The diary switch saves immediately; the briefing
 * card keeps an explicit draft (owned by the settings page) until 保存简报设置
 * submits every scheduling field through `discovery.configure` in one command.
 */
export function ProactivityPanel({ api, diary = false, keyMissing = false, memory, briefingDraft, onBriefingDraftChange }: any) {
    const { state, busy, error, command } = useCommand(api), s = state?.settings ?? {};
    const [localDraft, setLocalDraft] = useState<any>(null);
    const editedDraft = onBriefingDraftChange ? briefingDraft : localDraft;
    const setDraft = onBriefingDraftChange ?? setLocalDraft;
    // Untouched rows keep following the latest server state; only edited keys
    // overlay the draft, so changing one slot never clears the other rows.
    const draft = editedDraft ? { ...s, ...editedDraft } : s;
    const connected = !!state && !busy;
    const configure = (params: any) => command('discovery.configure', params);
    const change = (key: string, value: any) => setDraft((prior: any) => ({ ...prior, [key]: value }));
    const weekdays: number[] = draft.briefing_weekdays ?? [1, 2, 3, 4, 5];
    const toggleWeekday = (day: number, on: boolean) => change('briefing_weekdays', on ? [...new Set([...weekdays, day])].sort((a: number, b: number) => a - b) : weekdays.filter((value: number) => value !== day));
    async function saveBrief() {
        const params: any = {
            briefing_outlook_enabled: draft.briefing_outlook_enabled ?? false,
            briefing_outlook_time: draft.briefing_outlook_time ?? '08:30',
            briefing_review_enabled: draft.briefing_review_enabled ?? false,
            briefing_review_time: draft.briefing_review_time ?? '18:30',
            briefing_weekdays: weekdays,
            quiet_start: draft.quiet_start ?? '22:00',
            quiet_end: draft.quiet_end ?? '08:00'
        };
        if (!params.briefing_weekdays.length && (params.briefing_outlook_enabled || params.briefing_review_enabled))
            throw Error(t('请选择至少一天'));
        for (const key of ['briefing_outlook_time', 'briefing_review_time', 'quiet_start', 'quiet_end'])
            if (!TIME_PATTERN.test(params[key]))
                throw Error(t('请输入有效时间'));
        await configure(params);
        setDraft((current: any) => current === editedDraft ? null : current);
    }
    return <div aria-busy={busy}>
        <p role="alert">{error}</p>
        {diary ? <>
            <Card title="每日日记" description="根据昨天经授权的记忆写日记，只供你浏览，不作为模型记忆。">
                <div className="brief-slot">
                    <label className="brief-toggle">
                        <input type="checkbox" role="switch" aria-label={t('写每日日记')} checked={s.diary_enabled !== false} disabled={!connected} onChange={(event: any) => void configure({ diary_enabled: event.target.checked }).catch(() => { })}/>
                        <span>{t('写每日日记')}</span>
                    </label>
                </div>
            </Card>
            <Card title="每日简报" description="在主对话中查看当天安排和进展。">
                {BRIEF_SLOTS.map(([key, title, timeTitle, fallback]) => <div className="brief-slot" key={key}>
                    <label className="brief-toggle">
                        <input type="checkbox" role="switch" aria-label={t(title)} checked={draft[key + '_enabled'] ?? false} disabled={!connected} onChange={(event: any) => change(key + '_enabled', event.target.checked)}/>
                        <span>{t(title)}</span>
                    </label>
                    <input type="time" aria-label={t(timeTitle)} value={draft[key + '_time'] ?? fallback} disabled={!connected || (draft[key + '_enabled'] ?? false) !== true} onChange={(event: any) => change(key + '_time', event.target.value)}/>
                </div>)}
                <div className="brief-days" role="group" aria-label={t('重复日期')}>
                    {WEEKDAY_LABELS.map((day, index) => <label className="day-chip" key={day}>
                        <input type="checkbox" aria-label={t(day)} checked={weekdays.includes(index + 1)} disabled={!connected} onChange={(event: any) => toggleWeekday(index + 1, event.target.checked)}/>
                        <span>{t(day)}</span>
                    </label>)}
                </div>
                <details className="brief-advanced">
                    <summary>{t('免打扰')}</summary>
                    <div className="brief-quiet">
                        <span>{t('从')}</span>
                        <input type="time" aria-label={t('免打扰开始')} value={draft.quiet_start ?? '22:00'} disabled={!connected} onChange={(event: any) => change('quiet_start', event.target.value)}/>
                        <span>{t('到')}</span>
                        <input type="time" aria-label={t('免打扰结束')} value={draft.quiet_end ?? '08:00'} disabled={!connected} onChange={(event: any) => change('quiet_end', event.target.value)}/>
                    </div>
                    <p className="personal-hint">{t('免打扰期间不发送提醒。')}</p>
                </details>
                <div className="brief-actions">
                    <Action disabled={!connected} action={saveBrief}>{t('保存简报设置')}</Action>
                </div>
            </Card>
        </> : <>
            <Card title="主动发现" description="有依据才提出建议；也包括提议目标和按节奏问候目标进展。关闭后这些都会停止，仍可主动交办任务。">
                <Field label="主动发现间隔" value={s.discovery_enabled ? String(s.discovery_interval_minutes) : '0'} options={['0', '15', '30', '60', '120'].map((v, i) => ({ value: v, label: ['关闭', '每 15 分钟', '每 30 分钟', '每小时', '每两小时'][i] }))} disabled={busy || !state?.capabilities?.discovery} onChange={(v: string) => void configure({ enabled: v !== '0', ...(v !== '0' ? { interval_minutes: Number(v) } : {}) }).catch(() => { })}/>
            </Card>
            <Card title="每日主动消息上限" description="agent 主动找你的消息每天最多几条；你自己发起的任务结果不计入。">
                <div className="cap-stepper">
                    <Action aria-label={t('减少上限')} disabled={busy || !state} action={() => configure({ proactive_daily_cap: Math.max(1, (s.proactive_daily_cap ?? 5) - 1) })}>−</Action>
                    <Field label="每日主动消息上限" type="number" min={1} max={10} step={1} value={s.proactive_daily_cap ?? 5} disabled={busy || !state} onChange={(v: number) => void configure({ proactive_daily_cap: Number.isFinite(v) ? Math.min(10, Math.max(1, Math.round(v))) : 5 }).catch(() => { })}/>
                    <Action aria-label={t('增加上限')} disabled={busy || !state} action={() => configure({ proactive_daily_cap: Math.min(10, (s.proactive_daily_cap ?? 5) + 1) })}>+</Action>
                </div>
            </Card>
            {keyMissing && <Card title="资讯相关度" description="未配置资讯评分密钥时，会用对话模型判断相关度；你的兴趣、文章标题和摘要会发给它。">
                <Field label="用对话模型判断资讯相关度" type="checkbox" value={s.news_rank_fallback !== false} disabled={busy || !state} onChange={(news_rank_fallback: boolean) => void configure({ news_rank_fallback }).catch(() => { })}/>
            </Card>}
            {memory && <Card title="记忆"><p>{t(memory.enabled ? '记忆嵌入可用' : '记忆嵌入不可用')} · {memory.reason}</p></Card>}
        </>}
    </div>;
}
export function ChatGptPanel({ api }: any) { const [view, setView] = useState<any>(null), [models, setModels] = useState<any[]>([]), [draft, setDraft] = useState<any>({}), [status, setStatus] = useState(''); const active = useRef<any>(null); async function run(action: string, value?: any) { if (!api)
    return; const account = active.current; try {
    const r = await api.action(action, value);
    if (action === 'models') {
        if (account === active.current)
            setModels(r);
    }
    else {
        active.current = r.active;
        setView(r);
        setDraft({ active: r.active ?? '', useModels: r.useModels, useCodex: r.useCodex, model: r.model ?? '' });
        setStatus(t(r.remoteRevocationConfirmed === false ? '已在本机退出，远端撤销未确认；可在 ChatGPT 设置断开授权。' : r.restartRequired ? '配置已保存，服务重启未完成，请重试。' : r.pending ? '请在浏览器中完成授权，然后刷新账号状态。' : r.accounts.some((a: any) => a.id === r.active && a.connected && a.planEnabled) ? 'ChatGPT 套餐授权已连接。' : '请登录并授权 ChatGPT 套餐使用。'));
    }
}
catch {
    setStatus(t('操作未完成，请检查网络、账号授权及系统安全存储后重试。'));
} } const patch = (k: string, v: any) => setDraft((d: any) => ({ ...d, [k]: v })); return <details id="chatgpt-settings" onToggle={e => { if (e.currentTarget.open)
    void run('status'); }}><summary>{t('ChatGPT 账号（官方登录）')}</summary><p>{t('主对话可使用 ChatGPT 套餐；语音识别和合成仍使用各自的服务。')}</p><Field label="账号" value={draft.active ?? ''} options={[{ value: '', label: '添加账号' }, ...(view?.accounts ?? []).map((a: any) => ({ value: a.id, label: `${a.email} · ${a.id.slice(-8)}${a.connected ? '' : ' · ' + t('已退出')}` }))]} onChange={(active: string) => { patch('active', active); setModels([]); if (active)
    void run('configure', { active }); }}/><Action disabled={!api} action={() => run('login', draft.active || null)}>Continue with ChatGPT</Action>{[['cancel', '取消登录'], ['status', '刷新账号状态'], ['logout', '退出当前账号']].map(([a, label]) => <Action key={a} disabled={!api} action={() => run(a)}>{t(label)}</Action>)}<Field label="ChatGPT 模型" value={draft.model ?? ''} options={[...models, ...(draft.model && !models.some(m => m.id === draft.model) ? [{ id: draft.model, name: draft.model }] : [])].map(m => ({ value: m.id, label: m.name }))} onChange={(v: string) => patch('model', v)}/><Action disabled={!api} action={() => run('models')}>{t('获取可用模型')}</Action><Field label="主对话与辅助推理使用 ChatGPT" type="checkbox" value={draft.useModels} onChange={(v: boolean) => patch('useModels', v)}/><Field label="Codex 执行器使用 ChatGPT" type="checkbox" value={draft.useCodex} onChange={(v: boolean) => patch('useCodex', v)}/><Action disabled={!api} action={() => run('configure', { ...(draft.active ? { active: draft.active } : {}), useModels: !!draft.useModels, useCodex: !!draft.useCodex, ...(draft.model ? { model: draft.model } : {}) })}>{t('应用并重启服务')}</Action><Action disabled={!api} action={() => run('usage')}>{t('ChatGPT 用量与授权')}</Action><p role="status">{status}</p></details>; }
