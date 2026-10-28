import React, { useEffect, useRef, useState } from 'react';
import { Action, Card, Field, useCommand } from './controls';
import { t } from '../../locale.mjs';

// The runtime delivery enum is fixed (runtime/src/notifications/contracts.ts). Every
// status gets a human label so the panel never renders a raw key such as `cancelled`.
const DELIVERY_STATUS_LABELS: Record<string, string> = {
    pending: '待发送',
    sending: '发送中',
    accepted: '平台已接收',
    retry_wait: '等待重试',
    blocked: '渠道不可用',
    unknown: '发送结果不确定',
    cancelled: '已取消',
    expired: '已过期',
    superseded: '已被新消息取代',
};
const FEISHU_STATE_LABELS: Record<string, string> = {
    ready: '已连接',
    connected: '已连接',
    paused: '同步已暂停',
    disconnected: '已断开，历史记录保留',
    authorizing: '等待飞书授权',
    error: '连接需要处理',
};
const UNSUPPORTED_REASON_LABELS: Record<string, string> = {
    unsupported_type: '不支持的消息格式',
    missing_body: '正文为空',
    malformed_body: '正文格式错误',
    invalid_identity: '消息身份无效',
    invalid_time: '消息时间无效',
    body_too_large: '正文超过大小限制',
};
const CONNECTED_STATES = ['ready', 'connected', 'paused'];
const RETRY_STATUSES = ['unknown', 'blocked'];

function deliveryStatusLabel(status: string) {
    const label = DELIVERY_STATUS_LABELS[status];
    return label ? t(label) : status;
}

/** Non-zero delivery counts as compact chips: `平台已接收 25 · 已取消 15`. */
function DeliveryCounts({ counts }: { counts?: Record<string, number> }) {
    const entries = Object.entries(counts ?? {}).filter(([status, count]) => DELIVERY_STATUS_LABELS[status] !== undefined && Number(count) > 0);
    if (!entries.length)
        return null;
    return <ul className="im-delivery-counts" aria-label={t('投递状态统计')}>
        {entries.map(([status, count]) => <li key={status} className="im-delivery-chip" data-status={status}>
            <span className="im-delivery-chip-label">{t(DELIVERY_STATUS_LABELS[status])}</span>{' '}
            <span className="im-delivery-chip-count">{String(count)}</span>
        </li>)}
    </ul>;
}

/** Only deliveries whose outcome is unknown or whose channel is blocked need a decision. */
function DeliveryRetries({ deliveries, busy, retry }: { deliveries: any[]; busy: boolean; retry: (delivery: any) => void }) {
    if (!deliveries.length)
        return null;
    return <ul className="im-delivery-list" aria-label={t('需要处理的投递')}>
        {deliveries.map((delivery: any) => <li key={delivery.id} className="im-delivery-row">
            <p className="im-delivery-title">{delivery.title} · {deliveryStatusLabel(delivery.status)}</p>
            {delivery.status === 'unknown' && <p className="im-delivery-note">{t('对方可能已经收到，请先在接收渠道核实。再次发送可能产生重复消息。')}</p>}
            <Action disabled={busy} action={() => retry(delivery)}>{t(delivery.status === 'unknown' ? '确认可能重复，仍重新发送' : '重试发送')}</Action>
        </li>)}
    </ul>;
}

export function ImPanel({ api }: any) {
    const { state, busy, error, command } = useCommand(api, 'feishuCommand', 'feishu.status');
    const [notifications, setNotifications] = useState<any>(null);
    const [chats, setChats] = useState<any>(null);
    const [selected, setSelected] = useState<string[]>([]);
    const [consent, setConsent] = useState(false);
    const [allHistory, setHistory] = useState(false);
    const [bind, setBind] = useState(false);
    const [appId, setAppId] = useState('');
    const [verification, setVerification] = useState('');
    const [outbound, setOutbound] = useState('');
    const [deleting, setDeleting] = useState(false);
    const appSecret = useRef<HTMLInputElement>(null);
    const opened = useRef('');
    const account = state?.account_id ?? state?.account_name;

    useEffect(() => {
        setChats(null);
        setConsent(false);
        setSelected([]);
        setVerification('');
    }, [account]);

    useEffect(() => {
        let alive = true;
        void api.feishuCommand('notifications.status', {}).then((snapshot: any) => {
            if (alive)
                setNotifications(snapshot?.primary_binding_id ? snapshot : null);
        }).catch(() => { });
        return () => { alive = false; };
    }, [state, api]);

    useEffect(() => {
        if (state?.app_setup?.state !== 'waiting')
            return;
        const timer = setTimeout(() => void command().catch(() => { }), 1500);
        return () => clearTimeout(timer);
    }, [state, command]);

    async function call(method: string, params: any = {}) {
        const result = await command(method.startsWith('notifications.') ? method : 'feishu.' + method, params);
        if (method === 'app.start' && result?.app_setup?.verification_url && opened.current !== result.app_setup.verification_url) {
            opened.current = result.app_setup.verification_url;
            await api.openFeishuVerification(opened.current);
        }
        return result;
    }

    async function loadChats() {
        const result = await call('chats');
        setChats(result);
        setSelected((result.chats ?? []).filter((chat: any) => chat.selected).map((chat: any) => chat.id));
        setHistory(state?.all_history === true);
        setConsent(false);
    }

    async function authorizeNotificationDelivery() {
        const result = await call('notification.login');
        setOutbound(result?.verification_url ?? '');
        if (result?.verification_url)
            await api.openFeishuVerification(result.verification_url);
    }

    async function completeNotificationDelivery() {
        await call('complete');
        setOutbound('');
    }

    async function switchToFeishu() {
        await call('notification.configure', { enabled: true });
        await call('notifications.configure', { binding_id: 'feishu' });
    }

    function retryDelivery(delivery: any) {
        return call('notifications.retry', { id: delivery.id, ...(delivery.status === 'unknown' ? { confirm_unknown: true } : {}) });
    }

    const connected = CONNECTED_STATES.includes(state?.state);
    const completed = connected && state?.scope_configured === true;
    const rows = chats?.chats ?? state?.chats ?? [];
    const discoveryComplete = (chats?.chat_discovery_complete ?? state?.chat_discovery_complete) !== false;
    const retries = (notifications?.deliveries ?? []).filter((delivery: any) => RETRY_STATUSES.includes(delivery.status)).slice(-10);
    const unsupportedIssues: [string, number][] = Object.entries(state?.unsupported_messages ?? {}).filter(([, count]) => Number(count) > 0) as [string, number][];

    function setupContent() { return <>
        {state.app_setup?.state === 'waiting' ? <>
            <p role="status">{t('正在等待你完成飞书页面上的操作。此窗口可以保持打开。')}</p>
            {state.app_setup.verification_url && <Action disabled={busy} action={() => api.openFeishuVerification(state.app_setup.verification_url)}>{t('继续在飞书中配置')}</Action>}
            <Action disabled={busy} action={() => call('app.status')}>{t('我已完成，继续')}</Action>
            <Action disabled={busy} action={() => call('app.cancel')}>{t('取消配置')}</Action>
        </> : <>
            {state.app_setup?.error && <p role="alert">{state.app_setup.error}</p>}
            <Action disabled={busy} action={() => call('app.start')}>{t('创建飞书应用')}</Action>
            <Action disabled={busy} action={() => setBind(!bind)}>{t('绑定已有应用')}</Action>
            {bind && <>
                <p className="personal-hint">{t('在飞书开放平台的应用详情中，找到「凭证与基础信息」。')}</p>
                <Action disabled={busy} action={() => api.openFeishuVerification('https://open.feishu.cn/app')}>{t('打开飞书开放平台')}</Action>
                <Field label="App ID" value={appId} onChange={setAppId}/>
                <label>App Secret<input type="password" aria-label="App Secret" ref={appSecret} autoComplete="off"/></label>
                <Action disabled={busy} action={async () => {
                    const secret = appSecret.current?.value ?? '';
                    if (appSecret.current)
                        appSecret.current.value = '';
                    await call('app.bind', { app_id: appId.trim(), app_secret: secret });
                    setBind(false);
                }}>{t('绑定并继续')}</Action>
            </>}
        </>}
    </>; }

    function authContent() { return <>
        <p className="personal-hint">{t(state.auth_issue === 'expired' ? '飞书账号授权已过期，同步和机器人提醒已暂停。请重新扫码授权，无需重新绑定应用；已选会话和本地历史保留。' : state.auth_issue === 'missing_scopes' ? '飞书账号缺少所需读取权限。请重新授权，无需重新绑定应用。' : '应用已连接。接下来授权你的账号，授权后再选择要同步的会话。')}</p>
        <Action disabled={busy} action={async () => {
            const result = await call('login');
            setVerification(result?.verification_url ?? '');
            if (result?.verification_url)
                await api.openFeishuVerification(result.verification_url);
        }}>{t(['expired', 'missing_scopes'].includes(state.auth_issue) ? '重新授权飞书' : '登录飞书')}</Action>
        {verification && <>
            <Action disabled={busy} action={() => api.openFeishuVerification(verification)}>{t('打开飞书授权页面')}</Action>
            <Action disabled={busy} action={async () => { await call('complete'); setVerification(''); await loadChats(); }}>{t('我已完成授权')}</Action>
        </>}
    </>; }

    function connectedContent() { return <>
        <p className="personal-hint">{t('消息最多保留 30 天；较早历史从导入时计时。')}</p>
        {completed && !chats && <p role="status">{t('已保存同步范围。你可以随时调整会话或暂停同步。')}</p>}
        <Action disabled={busy} action={loadChats}>{t(!discoveryComplete ? '继续加载会话' : completed ? '调整会话' : '选择会话')}</Action>
        {!discoveryComplete && <p className="personal-hint">{t('会话列表尚未完整加载，请继续加载后选择。')}</p>}
        {rows.length > 0 && discoveryComplete && (!completed || chats) && <>
            <fieldset className="im-chat-selection">
                <legend>{t('选择要同步的会话')}</legend>
                <Action disabled={busy} action={() => setSelected(rows.map((chat: any) => chat.id))}>{t('全选')}</Action>
                <Action action={() => setSelected([])}>{t('取消全选')}</Action>
                <p className="personal-hint">{t('最近活跃优先')}</p>
                <div className="im-chat-list" role="group" aria-label={t('可同步的飞书会话')} tabIndex={0}>
                    {rows.map((chat: any) => <Field key={chat.id} label={chat.name || '未命名会话'} type="checkbox" value={selected.includes(chat.id)} disabled={busy} onChange={(checked: boolean) => setSelected(ids => checked ? [...ids, chat.id] : ids.filter(id => id !== chat.id))}/>)}
                </div>
            </fieldset>
            <Field label="读取所选会话的全部历史消息" type="checkbox" value={allHistory} disabled={busy} onChange={setHistory}/>
            <Field label="允许读取所选会话并保存在本机" type="checkbox" value={consent} disabled={busy} onChange={setConsent}/>
            <Action disabled={busy || !consent} action={async () => { await call('configure', { chat_ids: selected, consent: true, all_history: allHistory }); setChats(null); }}>{t('完成配置')}</Action>
        </>}
        {chats && discoveryComplete && !rows.length && <p className="personal-hint">{t('没有可选会话。请确认账号权限后重新加载。')}</p>}
        {completed && state.history_complete !== undefined && <p className="personal-hint">{t(state.history_complete ? '历史读取已完成。' : '历史消息仍在同步，稍后继续。')}</p>}
        {unsupportedIssues.length > 0 && <p className="personal-hint">{t('未提取正文：{0} 条。{1}', unsupportedIssues.reduce((sum, [, count]) => sum + count, 0), unsupportedIssues.map(([reason, count]) => `${t(UNSUPPORTED_REASON_LABELS[reason] ?? reason)} ${String(count)}`).join(' · '))}</p>}
        <Field label="允许设置中的模型服务处理飞书内容" type="checkbox" value={state.processing_consent_required === false} disabled={!completed || busy} onChange={(next: boolean) => void call('consent', { consent: next }).catch(() => { })}/>
        <p className="personal-hint">{t('读取与模型处理分别授权。调整会话后需重新开启。')}</p>
        {state.processing_consent_required && <p className="personal-hint">{t('尚未授权处理，或模型服务已变更。')}</p>}
        {state.last_sync && <p className="personal-hint">{t('上次同步：{0}', state.last_sync)}</p>}
        <div className="im-sync-actions">
            {[['sync', '立即同步'], [state.state === 'paused' ? 'resume' : 'pause', state.state === 'paused' ? '恢复同步' : '暂停同步'], ['disconnect', '断开（保留历史）']].map(([method, label]) => <Action key={method} disabled={busy} action={async () => { await call(method); if (method === 'disconnect') setChats(null); }}>{t(label)}</Action>)}
        </div>
        <details className="im-bot-setup">
            <summary>{t('设置 Nova 的飞书机器人')}</summary>
            <p className="personal-hint">{t('在应用后台添加机器人能力，按页面提示配置权限、发布应用并确认你在可用范围内，再到飞书打开机器人私聊。完成后开启下方提醒。')}</p>
            <Action disabled={busy} action={() => api.openFeishuVerification(state.app_id ? 'https://open.feishu.cn/app/' + encodeURIComponent(state.app_id) : 'https://open.feishu.cn/app')}>{t('打开应用后台')}</Action>
        </details>
        {!notifications?.configured && <Field label="在飞书私聊中接收 Nova 提醒" type="checkbox" value={state.bot_enabled === true} disabled={busy} onChange={(enabled: boolean) => void call('bot.configure', { enabled }).catch(() => { })}/>}
    </>; }

    return <div aria-busy={busy}>
        <p role="alert" hidden={!error}>{error}</p>
        <Card title="飞书" description="同步飞书会话，并在飞书中接收 Nova 的主动消息。">
            {notifications && <section className="im-proactive" aria-labelledby="im-proactive-title">
                <div className="im-proactive-heading">
                    <h4 id="im-proactive-title">{t('主动消息')}</h4>
                    <p className="im-proactive-channel" data-channel={notifications.local ? 'nova' : 'feishu'}>{t(notifications.local ? '当前渠道：Nova' : '当前渠道：飞书')}</p>
                </div>
                <div className="im-proactive-actions">
                    {!notifications.local && <Action disabled={busy} action={() => call('notifications.configure', { binding_id: 'nova' })}>{t('改为在 Nova 接收')}</Action>}
                    {state?.available && state?.configured ? <>
                        {!state.notification_ready ? <>
                            <Action disabled={busy} action={authorizeNotificationDelivery}>{t('授权飞书消息接收')}</Action>
                            {outbound && <Action disabled={busy} action={completeNotificationDelivery}>{t('已完成消息接收授权')}</Action>}
                        </> : (notifications.local || !state.notification_enabled) && <Action disabled={busy} action={switchToFeishu}>{t('改为在飞书接收')}</Action>}
                    </> : <p className="personal-hint">{t('连接飞书应用后可改为在飞书接收。')}</p>}
                </div>
                <DeliveryCounts counts={notifications.counts}/>
                <DeliveryRetries deliveries={retries} busy={busy} retry={retryDelivery}/>
                <details className="im-proactive-help">
                    <summary>{t('投递说明')}</summary>
                    <p className="personal-hint">{t('选择 Nova 主动提醒的接收位置。你发起的对话仍在 Nova 中回复。')}</p>
                    <p className="personal-hint">{t('飞书接收无需开启会话采集。发送失败时会保留状态，不会自动改发到 Nova。审批和继续任务仍在 Nova 中操作。')}</p>
                </details>
                <div className="im-proactive-footer">
                    <Action disabled={busy} action={() => call('notifications.status')}>{t('刷新投递状态')}</Action>
                </div>
            </section>}

            {!state ? <p>{t('正在读取连接状态…')}</p> : !state.available ? <>
                <p className="personal-hint">{state.error || t('当前运行环境尚未启用飞书连接。')}</p>
                <p className="personal-hint">{t('需要安装 lark-cli 1.0.69 或更高版本，再重新打开 Nova。')}</p>
            </> : <>
                {!connected && <ol className="im-steps" aria-label={t('飞书连接进度')}>
                    {['连接应用', '授权账号', '选择会话'].map((title, index) => <li key={title} aria-current={index === (!state.configured ? 0 : !connected ? 1 : 2) ? 'step' : undefined}>
                        <span className="im-step-index" aria-hidden="true">{index + 1}</span>
                        <span className="im-step-label">{t(title)}</span>
                    </li>)}
                </ol>}
                {!state.configured ? setupContent() : <>
                    <p className="im-feishu-state">{t(FEISHU_STATE_LABELS[state.state] ?? '尚未登录')}{state.account_name ? ' · ' + state.account_name : ''}</p>
                    <p role="status">{state.error}</p>
                    {!connected ? authContent() : connectedContent()}
                </>}
            </>}
            {state?.available && <div className="im-feishu-actions">
                <Action disabled={busy} action={() => call('status')}>{t('刷新状态')}</Action>
                {state.configured && <>
                    <Action disabled={busy} action={() => setDeleting(true)}>{t('删除本地历史')}</Action>
                    {deleting && <div className="im-delete-history" role="group" aria-label={t('确认删除飞书历史')}>
                        <p>{t('删除本地已保存的飞书消息及其索引？依赖这些消息的记忆和建议会更新或撤回。飞书中的原消息不会被删除。')}</p>
                        <Action disabled={busy} action={async () => { await call('delete'); setChats(null); setDeleting(false); }}>{t('确认删除本地历史')}</Action>
                        <Action action={() => setDeleting(false)}>{t('取消')}</Action>
                    </div>}
                </>}
            </div>}
        </Card>
    </div>;
}
