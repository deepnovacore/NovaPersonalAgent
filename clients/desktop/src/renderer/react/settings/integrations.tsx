import React, { useEffect, useRef, useState } from 'react';
import { Action, Card, Field, useCommand } from './controls';
import { t } from '../../locale.mjs';

/**
 * Connectors are split per detail page by toolkit so the entry page can open one
 * integration at a time. The command vocabulary is unchanged: every mutation
 * still goes through `personalCommand('connector.*', …)` or `personalCommand('state')`.
 */
const SOURCE_STATE_LABELS: Record<string, string> = {
    connected: '已连接',
    paused: '已暂停',
    disconnected: '已断开',
    error: '异常',
};
const CONNECTION_STATE_LABELS: Record<string, string> = {
    authorizing: '等待授权',
    connected: '已连接',
    paused: '已暂停',
    disconnected: '已断开，保留已同步数据',
};
const TOOLKIT_TITLES: Record<string, string> = {
    gmail: 'Gmail',
    macos_mail: '本机邮件',
    macos_calendar: '本机日历',
    googlecalendar: 'Google 日历',
};
const MAIL_TOOLKITS = ['gmail', 'macos_mail'];
const CALENDAR_TOOLKITS = ['googlecalendar', 'macos_calendar'];

function connectionStateLabel(state: string) {
    return CONNECTION_STATE_LABELS[state] ?? state;
}

function toolkitTitle(toolkit: string) {
    return TOOLKIT_TITLES[toolkit] ?? toolkit;
}

/** 本机资料: authorized directories and the whole-computer grant. */
export function FilesPanel({ api }: any) {
    const { state, busy, error, command } = useCommand(api);
    const [consent, setConsent] = useState(false);
    const [deleting, setDeleting] = useState<string | null>(null);
    const root = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!state?.sources?.some((source: any) => source.scan_pending))
            return;
        const timer = setInterval(() => {
            if (document.visibilityState === 'visible' && !root.current?.contains(document.activeElement))
                void command().catch(() => { });
        }, 5000);
        return () => clearInterval(timer);
    }, [state, command]);
    const computer = state?.sources?.find((source: any) => source.scope === 'computer' && source.state !== 'disconnected');
    return <div ref={root} aria-busy={busy} className="connector-panel" data-panel="files">
        <p role="alert" hidden={!error}>{error}</p>
        <Card title="本机目录" description="已授权的来源列在下方；新增来源时单独确认读取和模型处理权限。">
            <details open={!state?.sources?.length}>
                <summary>{t('添加授权来源')}</summary>
                <Field label="允许将授权资料的片段发送给当前配置的模型，用于理解与检索。" type="checkbox" value={consent} onChange={setConsent}/>
                <Action disabled={!consent || busy} action={async () => {
                    const path = await api.chooseDirectory();
                    if (path) {
                        await command(computer ? 'sources.priority.add' : 'sources.add', computer ? { path } : { path, consent: true });
                        setConsent(false);
                    }
                }}>{t(computer ? '选择优先整理的目录' : '选择并授权目录')}</Action>
                <Action disabled={!consent || busy} action={async () => {
                    await command('sources.authorize_computer', { consent: true });
                    setConsent(false);
                }}>{t('授权本机全部可访问数据')}</Action>
                <p className="hint">{t('全机模式分批持续处理。系统权限仍由 macOS / Windows 管理；不读取凭据、密钥、系统文件、依赖和构建缓存。暂停会停止后续读取。')}</p>
                {!state?.capabilities?.sources && <p>{t('授权时会同时启用本机资料服务。')}</p>}
            </details>
            <Action disabled={busy} action={() => command()}>{t('刷新')}</Action>
        </Card>
        {!state?.sources?.length && <p className="personal-hint">{t('尚未授权本机目录。选择目录后可让 Nova 在授权范围内读取与检索资料。')}</p>}
        <ul className="source-list" aria-label={t('已授权来源')}>
            {(state?.sources ?? []).map((source: any) => <li key={source.id}>
                <Card title={source.scope === 'computer' ? '本机全部可访问数据' : source.path}>
                    <p>{t(SOURCE_STATE_LABELS[source.state] ?? source.state)} · {t('扫描 {0}', source.scanned ?? 0)} · {t('本次读取正文 {0}', source.read ?? 0)} · {t('跳过 {0}', source.skipped ?? 0)}</p>
                    {source.scope === 'computer' && <>
                        <p>{t('已索引 {0} 份文档 · {1}', source.indexed ?? 0, t(source.scan_pending ? '后台处理进行中' : '本轮遍历结束'))}</p>
                        {(source.priority_dirs ?? []).map((path: string) => <div className="source-priority-row" key={path}>
                            {t('优先整理：{0}', path)}
                            <Action disabled={busy} action={() => command('sources.priority.remove', { path })}>{t('移除优先目录')}</Action>
                        </div>)}
                    </>}
                    <p>{t('上次同步：{0}', source.last_sync ?? t('尚未同步'))}</p>
                    <p>{t(source.processing_consent_required === false ? '已授权当前模型处理' : '需要确认当前模型处理权限')}</p>
                    {source.processing_consent_required && <Action disabled={busy} action={() => command('sources.consent', { id: source.id, consent: true })}>{t('授权当前模型处理')}</Action>}
                    <details>
                        <summary>{t('同步详情')}</summary>
                        <p>{t('排除：{0}', (source.excludes ?? []).join(', '))}</p>
                        <p>{t('跳过原因：{0}', JSON.stringify(source.reasons ?? {}))}</p>
                        {(source.failures ?? []).map((failure: any, index: number) => <p key={index}>{failure.path} · {failure.code}</p>)}
                    </details>
                    {source.state !== 'disconnected' && [
                        [source.state === 'paused' ? '恢复同步' : '暂停同步', source.state === 'paused' ? 'resume' : 'pause'],
                        ['立即同步', 'sync'],
                        ['断开（保留数据）', 'disconnect'],
                    ].map(([label, method]) => <Action key={method} disabled={busy} action={() => command('sources.' + method, { id: source.id })}>{t(label)}</Action>)}
                    <Action disabled={busy} action={() => setDeleting(source.id)}>{t('删除来源数据')}</Action>
                    {deleting === source.id && <div role="group" aria-label={t('确认删除来源数据')}>
                        <p>{t('确认删除「{0}」的索引与来源记录？依赖此来源的记忆和建议也会更新或撤回；不会删除磁盘原文件。', source.path)}</p>
                        <Action disabled={busy} action={async () => { await command('sources.delete', { id: source.id }); setDeleting(null); }}>{t('确认删除来源数据')}</Action>
                        <Action action={() => setDeleting(null)}>{t('取消删除')}</Action>
                    </div>}
                </Card>
            </li>)}
        </ul>
    </div>;
}

const PANEL_COPY: Record<'mail' | 'calendar', any> = {
    mail: {
        title: '连接方式',
        description: '本机邮件使用系统权限；Gmail 通过 Composio 授权。Nova 只读取所选范围，不会代你发送或修改邮件；托管授权可能包含写入权限，请以授权页面为准。',
        toolkits: MAIL_TOOLKITS,
        localKey: 'mail',
        localLabel: '连接本机邮件',
        localAsk: '向系统申请邮件权限',
        localHint: '请先打开 Apple 邮件；Nova 需要自动化权限来只读所选邮箱，不发送或修改邮件。',
        linkToolkit: 'gmail',
        linkLabel: '连接 Gmail',
        empty: '尚未连接邮件。连接后可同步所选邮箱的最近邮件；支持本机邮件和 Gmail。',
    },
    calendar: {
        title: '连接方式',
        description: '本机日历使用系统权限；Google 日历通过 Composio 授权。Nova 只读取所选范围，不会修改日程；托管授权可能包含写入权限，请以授权页面为准。',
        toolkits: CALENDAR_TOOLKITS,
        localKey: 'local',
        localLabel: '连接本机日历',
        localAsk: '向系统申请日历权限',
        localHint: 'macOS 要求完整日历访问权限才能读取日程；Nova 只读，不修改日程。',
        linkToolkit: 'googlecalendar',
        linkLabel: '连接 Google 日历',
        empty: '尚未连接日历。连接后可读取所选日历的近期日程；支持本机日历和 Google 日历。',
    },
};

function ConnectorPanel({ kind, api }: { kind: 'mail' | 'calendar'; api: any }) {
    const copy = PANEL_COPY[kind];
    const { state, busy, error, command } = useCommand(api);
    const [permissions, setPermissions] = useState<Record<string, boolean>>({});
    const [urls, setUrls] = useState<Record<string, string>>({});
    const call = (method: string, params: any = {}) => command('connector.' + method, params);
    const snapshot = state?.connectors;
    const rows = (snapshot?.connections ?? []).filter((connection: any) => copy.toolkits.includes(connection.toolkit));
    const localKey = copy.localKey;
    const localAvailable = snapshot?.[localKey + '_available'] === true;
    async function connectLocal() {
        const result = await call(localKey + '_status');
        if (result?.status !== 'granted') {
            setPermissions((previous) => ({ ...previous, [localKey]: true }));
            return;
        }
        await call(localKey + '_connect');
    }
    async function grantLocalPermission() {
        await call(localKey + '_access');
        await call(localKey + '_connect');
        setPermissions((previous) => ({ ...previous, [localKey]: false }));
    }
    async function linkGoogle() {
        const result = await call('link', { toolkit: copy.linkToolkit });
        if (!result?.url)
            return;
        setUrls((previous) => ({ ...previous, [result.id]: result.url }));
        await api.openConnectorAuthorization(result.url);
    }
    return <div aria-busy={busy} className="connector-panel" data-panel={kind}>
        <p role="alert" hidden={!error}>{error}</p>
        <Card title={copy.title} description={copy.description}>
            {!snapshot && <p className="personal-hint">{t('连接器服务当前不可用，请重启 Nova 后重试。')}</p>}
            {snapshot && !snapshot.available && <p className="personal-hint">{t('Google 连接需要在设置 → API 密钥填写 Composio 密钥。')}</p>}
            {snapshot?.memory_available === false ? <p className="personal-hint">{t('请先在本机配置中启用本地记忆，再连接应用。')}</p> : snapshot && <>
                {localAvailable && <>
                    <Action disabled={busy} action={connectLocal}>{t(copy.localLabel)}</Action>
                    {permissions[localKey] && <>
                        <p className="personal-hint">{t(copy.localHint)}</p>
                        <Action disabled={busy} action={grantLocalPermission}>{t(copy.localAsk)}</Action>
                    </>}
                </>}
                {snapshot.available && <Action disabled={busy} action={linkGoogle}>{t(copy.linkLabel)}</Action>}
                <Action disabled={busy} action={() => call('status')}>{t('刷新连接')}</Action>
            </>}
        </Card>
        {snapshot?.memory_available !== false && rows.map((connection: any) => <Connector key={connection.id} connection={connection} call={call} busy={busy} url={urls[connection.id]} api={api}/>)}
        {snapshot && snapshot.memory_available !== false && !rows.length && <p className="personal-hint">{t(copy.empty)}</p>}
    </div>;
}

export function MailPanel({ api }: any) {
    return <ConnectorPanel kind="mail" api={api}/>;
}

export function CalendarPanel({ api }: any) {
    return <ConnectorPanel kind="calendar" api={api}/>;
}

/** One connected account: scope editing, sync controls and local data deletion. */
function Connector({ connection: c, call, busy, url, api }: any) {
    const [edit, setEdit] = useState<any>(null);
    const [deleting, setDeleting] = useState(false);
    const patch = (values: any) => setEdit((previous: any) => ({ ...previous, ...values }));
    const id = c.id;
    const hasFuture = !['gmail', 'macos_mail'].includes(c.toolkit);
    const past = edit?.pastDays ?? c.scope?.pastDays ?? (c.toolkit === 'macos_mail' ? 180 : 30);
    async function loadScopes() {
        const choices = await call('scopes', { id });
        setEdit({
            choices,
            selected: c.scope?.labels ?? c.scope?.calendars ?? c.scope?.mailboxes ?? [],
            processing: !!c.processing_allowed,
        });
    }
    async function loadMore() {
        const next = await call('scopes', { id, pageToken: edit.choices.next });
        patch({ choices: { items: [...edit.choices.items, ...next.items], next: next.next } });
    }
    async function saveScope() {
        const scope = hasFuture
            ? { kind: 'calendar', calendars: edit.selected, pastDays: past, futureDays: edit.futureDays ?? c.scope?.futureDays ?? 90 }
            : c.toolkit === 'macos_mail'
                ? { kind: 'macos_mail', mailboxes: edit.selected, pastDays: past }
                : { kind: 'gmail', labels: edit.selected, pastDays: past };
        await call('configure', { id, scope, processingConsent: edit.processing });
        setEdit(null);
    }
    const title = toolkitTitle(c.toolkit);
    const identity = c.identity && c.identity !== title ? ' · ' + c.identity : '';
    return <Card title={title + identity} description={t(connectionStateLabel(c.state))}>
        {c.toolkit === 'macos_mail' && <p>{t('仅扫描最近最多 180 天，每轮最多检查 500 封；达到限额时不撤回范围外邮件。')}</p>}
        {c.scan_limited && <p>{t('已达到 500 封扫描上限，仅完成限额内读取。')}</p>}
        {c.last_complete && <p>{t('最近完整同步：')}{new Date(c.last_complete).toLocaleString()}</p>}
        {c.last_attempt && <p>{t('最近尝试：')}{new Date(c.last_attempt).toLocaleString()}</p>}
        {c.error && <p role="alert">{t('同步需要处理：')}{c.error}</p>}
        {c.has_pending && <p>{t('正在分批同步，已保存进度。')}</p>}
        {c.state === 'authorizing' ? <>
            {url && <Action disabled={busy} action={() => api.openConnectorAuthorization(url)}>{t('打开授权页面')}</Action>}
            <Action disabled={busy} action={() => call('complete', { id })}>{t('我已完成授权')}</Action>
        </> : <>
            <Action disabled={busy} action={loadScopes}>{t(c.scope ? '调整同步范围' : '选择同步范围')}</Action>
            {edit && <>
                <fieldset className="selection-list">
                    <legend>{t('允许读取的标签、邮箱文件夹或日历')}</legend>
                    {edit.choices.items.map((item: any) => <Field key={item.id} label={item.name} type="checkbox" value={edit.selected.includes(item.id)} onChange={(checked: boolean) => patch({ selected: checked ? [...edit.selected, item.id] : edit.selected.filter((selectedId: string) => selectedId !== item.id) })}/>)}
                </fieldset>
                {edit.choices.next && <Action disabled={busy} action={loadMore}>{t('加载更多')}</Action>}
                <Field label="回溯天数" type="number" min={1} max={c.toolkit === 'macos_mail' ? 180 : 365} value={past} onChange={(pastDays: number) => patch({ pastDays })}/>
                {hasFuture && <Field label="未来天数" type="number" min={1} max={365} value={edit.futureDays ?? c.scope?.futureDays ?? 90} onChange={(futureDays: number) => patch({ futureDays })}/>}
                <Field label="允许将所选原文发送给已配置的模型服务，抽取记忆和生成向量" type="checkbox" value={edit.processing} onChange={(processing: boolean) => patch({ processing })}/>
                <Action disabled={busy} action={saveScope}>{t('保存范围并开始同步')}</Action>
            </>}
            {c.scope && <>
                <p>{t(c.processing_allowed ? '已允许模型处理所选内容' : '仅保存在本机，不发送内容给模型')}</p>
                {c.processing_allowed && <Action disabled={busy} action={() => call('consent', { id, processingConsent: false })}>{t('撤回模型处理同意')}</Action>}
                {[
                    ['sync', '立即同步'],
                    [c.state === 'connected' ? 'pause' : 'resume', c.state === 'connected' ? '暂停同步' : '恢复同步'],
                    ['disconnect', '断开连接'],
                ].map(([method, label]) => <Action key={method} disabled={busy} action={() => call(method, { id })}>{t(label)}</Action>)}
            </>}
            <Action disabled={busy} action={() => setDeleting(true)}>{t('删除本地数据')}</Action>
            {deleting && <>
                <p>{t('删除 Nova 中此连接的同步数据及关联记忆；不会删除原应用中的邮件或日程。')}</p>
                <Action disabled={busy} action={() => call('delete', { id })}>{t('确认删除本地数据')}</Action>
                <Action action={() => setDeleting(false)}>{t('取消')}</Action>
            </>}
        </>}
    </Card>;
}

export { ImPanel } from './im';
