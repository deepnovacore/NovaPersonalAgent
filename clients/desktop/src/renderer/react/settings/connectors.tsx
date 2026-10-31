import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@radix-ui/themes';
import {
    ArrowLeft,
    Calendar,
    ChevronRight,
    FolderOpen,
    Mail,
    MessagesSquare,
    RefreshCw,
    type LucideIcon,
} from 'lucide-react';
import { t } from '../../locale.mjs';
import { ImPanel } from './im';
import { CalendarPanel, FilesPanel, MailPanel } from './integrations';

/**
 * Connector settings use two hierarchy levels:
 * - the entry page lists one card per connector with a coarse status;
 * - opening a card shows the existing configuration panel behind a back button.
 * Space and phones intentionally live on their own left-nav category, not here.
 * Every mutation keeps its original command (`connector.*`, `sources.*`, `feishu.*`).
 */

type ConnectorTone = 'ok' | 'progress' | 'warn' | 'error' | 'muted';

interface ConnectorStatus {
    tone: ConnectorTone;
    label: string;
    /** Current state plus the next step, shown in place of the card summary. */
    detail?: string;
    /** A failed read: clicking the card retries instead of opening the detail. */
    retry?: boolean;
}

const STATUS: Record<string, ConnectorStatus> = {
    connected: { tone: 'ok', label: '已连接' },
    setup: { tone: 'warn', label: '待配置' },
    authorize: { tone: 'warn', label: '需要授权' },
    syncing: { tone: 'progress', label: '同步中' },
    paused: { tone: 'muted', label: '已暂停' },
    attention: { tone: 'error', label: '需处理' },
    unavailable: { tone: 'muted', label: '不可用' },
    offline: { tone: 'muted', label: '未连接' },
    checking: { tone: 'progress', label: '待检查' },
    failed: { tone: 'error', label: '读取失败' },
};
const CONNECTED = STATUS.connected!;
const CHECKING = STATUS.checking!;
const withDetail = (status: ConnectorStatus, detail: string): ConnectorStatus => ({ ...status, detail });

export const MAIL_TOOLKITS = ['gmail', 'macos_mail'];
export const CALENDAR_TOOLKITS = ['googlecalendar', 'macos_calendar'];
const CONNECTED_FEISHU_STATES = ['ready', 'connected'];

/** Short, user-safe reasons for a failed read; raw IPC and backend text never reaches the page. */
type ReadFailure = 'timeout' | 'busy' | 'restarting' | 'not_ready' | 'unavailable' | 'failed';
const FAILURE_REASON: Record<ReadFailure, string> = {
    timeout: '请求超时',
    busy: '后台繁忙',
    restarting: '后台正在重启',
    not_ready: '后台尚未就绪',
    unavailable: '后台暂不可用',
    failed: '后台返回错误',
};

function readFailure(result: PromiseSettledResult<any>): ReadFailure | null {
    if (result.status === 'rejected') {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason ?? '');
        if (/timeout|timed out/i.test(message))
            return 'timeout';
        if (/\bbusy\b/i.test(message))
            return 'busy';
        if (/connection changed|control closed/i.test(message))
            return 'restarting';
        if (/not ready|connections? unavailable/i.test(message))
            return 'not_ready';
        return /unavailable/i.test(message) ? 'unavailable' : 'failed';
    }
    const value = result.value;
    // The settings port replies `{error}` alone; a Feishu snapshot also carries a display `error`
    // (unverified login, sync failure) next to its state and must still render as a snapshot.
    if (!value || typeof value !== 'object' || typeof value.error !== 'string' || Object.keys(value).length !== 1)
        return null;
    if (value.error === 'busy')
        return 'busy';
    if (value.error === 'not_ready')
        return 'not_ready';
    return value.error === 'unavailable' ? 'unavailable' : 'failed';
}

function clip(text: string, max = 60) {
    const value = text.trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatTime(value: unknown) {
    if (value === null || value === undefined || value === '')
        return '';
    const date = new Date(value as string | number);
    if (Number.isNaN(date.getTime()))
        return '';
    const pad = (n: number) => String(n).padStart(2, '0');
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    return date.toDateString() === new Date().toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function failedStatus(failure: ReadFailure): ConnectorStatus {
    return { ...STATUS.failed!, detail: t('{0}，点此重试', t(FAILURE_REASON[failure])), retry: true };
}

/** Coarse Feishu status from the cached `feishu.status` snapshot. */
function deriveFeishuStatus(snapshot: any): ConnectorStatus {
    if (!snapshot || typeof snapshot !== 'object')
        return CHECKING;
    if (snapshot.available === undefined && snapshot.configured === undefined && snapshot.state === undefined)
        return CHECKING;
    if (snapshot.available === false)
        return withDetail(STATUS.unavailable!, t('未检测到可用的飞书 CLI，点此查看'));
    if (snapshot.state === 'error' || snapshot.unverified === true)
        return withDetail(STATUS.attention!, typeof snapshot.error === 'string' && snapshot.error.trim() ? t(clip(snapshot.error)) : t('连接出错，点此查看'));
    if (snapshot.auth_issue || snapshot.state === 'authorizing')
        return withDetail(STATUS.authorize!, snapshot.auth_issue === 'expired' ? t('登录已过期，点此重新授权')
            : snapshot.auth_issue === 'missing_scopes' ? t('权限不完整，点此重新授权') : t('尚未登录，点此授权'));
    if (snapshot.configured !== true)
        return withDetail(STATUS.setup!, t('尚未配置飞书应用，点此开始'));
    if (snapshot.state === 'paused')
        return withDetail(STATUS.paused!, t('同步已暂停，点此恢复'));
    if (snapshot.state === 'disconnected')
        return withDetail(STATUS.offline!, t('已断开连接，点此重新连接'));
    if (snapshot.state === 'unauthorized')
        return withDetail(STATUS.authorize!, t('尚未登录，点此授权'));
    if (CONNECTED_FEISHU_STATES.includes(snapshot.state)) {
        if (snapshot.scope_configured === false)
            return withDetail(STATUS.setup!, t('还没选要同步的会话，点此选择'));
        const synced = formatTime(snapshot.last_sync);
        return withDetail(CONNECTED, synced ? t('上次同步 {0}', synced) : t('已登录，点此管理同步的会话'));
    }
    return CHECKING;
}

/** Coarse status for 本机资料 from the authorized sources listed in personal state. */
function deriveFilesStatus(personal: any): ConnectorStatus {
    if (!personal)
        return CHECKING;
    const sources = personal.sources;
    if (!Array.isArray(sources))
        return CHECKING;
    if (!sources.length)
        return withDetail(STATUS.offline!, t('还没有授权文件夹，点此添加'));
    const failing = sources.filter((source: any) => source?.state === 'error').length;
    if (failing)
        return withDetail(STATUS.attention!, t('{0} 个文件夹读取出错，点此查看', failing));
    const active = sources.filter((source: any) => source?.state !== 'disconnected');
    if (active.some((source: any) => source?.scan_pending)) {
        const indexed = active.reduce((sum: number, source: any) => sum + (Number.isSafeInteger(source?.indexed) ? source.indexed : 0), 0);
        return withDetail(STATUS.syncing!, indexed > 0 ? t('正在扫描，已索引 {0} 个文件', indexed) : t('正在扫描文件夹'));
    }
    if (active.length && active.every((source: any) => source?.state === 'paused'))
        return withDetail(STATUS.paused!, t('同步已暂停，点此恢复'));
    return active.length ? withDetail(CONNECTED, t('已授权 {0} 个文件夹', active.length)) : withDetail(STATUS.offline!, t('还没有授权文件夹，点此添加'));
}

/** Coarse status for mail/calendar from the Composio connector snapshot. */
function deriveConnectorStatus(personal: any, toolkits: string[]): ConnectorStatus {
    if (!personal)
        return CHECKING;
    const mail = toolkits === MAIL_TOOLKITS;
    const connectors = personal.connectors;
    if (!connectors || typeof connectors !== 'object')
        return withDetail(STATUS.unavailable!, t('连接服务未启动，稍后再试'));
    if (connectors.memory_available === false)
        return withDetail(STATUS.setup!, t('需先开启记忆功能才能同步'));
    const rows = (connectors.connections ?? []).filter((connection: any) => toolkits.includes(connection?.toolkit));
    const failing = rows.find((connection: any) => connection?.error || connection?.state === 'error');
    if (failing)
        return withDetail(STATUS.attention!, typeof failing.error === 'string' && failing.error.trim() ? t(clip(failing.error)) : t('同步出错，点此查看'));
    const pending = rows.filter((connection: any) => connection?.has_pending && connection?.state === 'connected');
    if (pending.length) {
        const last = Math.max(0, ...pending.map((connection: any) => new Date(connection?.last_complete ?? 0).getTime() || 0));
        const finished = last > 0 ? formatTime(last) : '';
        return withDetail(STATUS.syncing!, finished ? t('正在同步，上次完成于 {0}', finished) : t('正在同步'));
    }
    if (rows.some((connection: any) => connection?.state === 'authorizing'))
        return withDetail(STATUS.authorize!, t('授权尚未完成，点此继续'));
    const connected = rows.filter((connection: any) => connection?.state === 'connected');
    if (connected.length) {
        const names = connected.map((connection: any) => connection?.identity).filter((name: unknown) => typeof name === 'string' && name);
        return withDetail(CONNECTED, names.length ? t('已连接：{0}', clip(names.join('、'), 40)) : t('已连接 {0} 个账户', connected.length));
    }
    if (rows.length && rows.every((connection: any) => connection?.state === 'paused'))
        return withDetail(STATUS.paused!, t('同步已暂停，点此恢复'));
    const localAvailable = mail ? connectors.mail_available === true : connectors.local_available === true;
    if (connectors.available !== true && !localAvailable)
        return withDetail(STATUS.unavailable!, t('连接服务未启动，稍后再试'));
    return withDetail(STATUS.offline!, mail ? t('尚未连接，点此连接邮箱') : t('尚未连接，点此连接日历'));
}

const READ_TIMEOUT_MS = 15_000;
/** A verified Feishu read is bounded to 15 s in the runtime; leave room for the IPC hop. */
const VERIFY_TIMEOUT_MS = 25_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('connector read timeout')), ms);
    });
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

interface SourceRead {
    data: any;
    failure: ReadFailure | null;
    pending: boolean;
}
const IDLE_READ: SourceRead = { data: null, failure: null, pending: true };

/**
 * Personal state and the Feishu snapshot are read independently: each settles on its own,
 * so a slow or failing Feishu read never hides the other three cards.
 * Normal loads read the cached Feishu snapshot; only an explicit refresh asks the CLI to verify.
 */
function useConnectorOverview(api: any, timeoutMs: number, verifyTimeoutMs: number) {
    const [personal, setPersonal] = useState<SourceRead>(IDLE_READ);
    const [feishu, setFeishu] = useState<SourceRead>(IDLE_READ);
    const mounted = useRef(true);
    const epoch = useRef(0);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            epoch.current++;
        };
    }, []);
    const load = useCallback(async ({ verify = false }: { verify?: boolean } = {}) => {
        const run = ++epoch.current;
        const read = async (method: 'personalCommand' | 'feishuCommand', name: string, params: any, ms: number, set: (value: (prior: SourceRead) => SourceRead) => void) => {
            set((prior) => ({ ...prior, pending: true }));
            const bridge = api?.[method];
            const [result] = await Promise.allSettled([typeof bridge === 'function' ? withTimeout(Promise.resolve(bridge.call(api, name, params)), ms) : Promise.resolve(null)]);
            if (!mounted.current || run !== epoch.current)
                return;
            const failure = readFailure(result!);
            if (failure)
                set((prior) => ({ ...prior, failure, pending: false }));
            else {
                const value = result!.status === 'fulfilled' ? result!.value : null;
                set(() => ({ data: value && typeof value === 'object' ? value : null, failure: null, pending: false }));
            }
        };
        await Promise.all([
            read('personalCommand', 'state', {}, timeoutMs, setPersonal),
            read('feishuCommand', 'feishu.status', verify ? {} : { cached: true }, verify ? verifyTimeoutMs : timeoutMs, setFeishu),
        ]);
    }, [api, timeoutMs, verifyTimeoutMs]);
    useEffect(() => {
        void load();
    }, [load]);
    const loading = personal.pending || feishu.pending;
    const loaded = !personal.pending || !feishu.pending || personal.data !== null || feishu.data !== null;
    return { personal, feishu, loading, loaded, reload: load };
}

interface ConnectorCard {
    id: string;
    title: string;
    summary: string;
    Icon: LucideIcon;
    panel: (api: any) => React.ReactNode;
}

const CONNECTOR_CARDS: ConnectorCard[] = [
    {
        id: 'feishu',
        title: '飞书',
        summary: '同步飞书会话，并在飞书中接收 Nova 的提醒。',
        Icon: MessagesSquare,
        panel: (api) => <ImPanel api={api}/>,
    },
    {
        id: 'files',
        title: '文件夹',
        summary: '授权本机目录，让 Nova 在范围内读取与检索资料。',
        Icon: FolderOpen,
        panel: (api) => <FilesPanel api={api}/>,
    },
    {
        id: 'mail',
        title: '邮件',
        summary: '连接本机邮件或 Gmail，只读所选邮箱。',
        Icon: Mail,
        panel: (api) => <MailPanel api={api}/>,
    },
    {
        id: 'calendar',
        title: '日历',
        summary: '连接本机日历或 Google 日历，只读所选范围。',
        Icon: Calendar,
        panel: (api) => <CalendarPanel api={api}/>,
    },
];

function ConnectorGrid({ statuses, loading, onOpen, onRetry, cardRefs }: any) {
    if (loading) {
        return <ul className="connector-grid" aria-label={t('正在读取连接状态…')} aria-busy="true">
            {CONNECTOR_CARDS.map((card) => <li key={card.id}>
                <div className="connector-card connector-card-skeleton" aria-hidden="true">
                    <span className="connector-card-icon"/>
                    <span className="connector-card-copy">
                        <span className="connector-skeleton-line"/>
                        <span className="connector-skeleton-line short"/>
                    </span>
                </div>
            </li>)}
        </ul>;
    }
    return <ul className="connector-grid" aria-label={t('连接器列表')}>
        {CONNECTOR_CARDS.map((card) => {
            const status = statuses[card.id] ?? CHECKING;
            const Icon = card.Icon;
            return <li key={card.id}>
                <button
                    type="button"
                    className="connector-card"
                    data-connector={card.id}
                    data-tone={status.tone}
                    ref={(element) => { cardRefs.current[card.id] = element; }}
                    onClick={() => status.retry ? onRetry() : onOpen(card.id)}
                >
                    <span className="connector-card-icon" aria-hidden="true"><Icon size={22} strokeWidth={1.8}/></span>
                    <span className="connector-card-copy">
                        <span className="connector-card-title">{t(card.title)}</span>
                        <span className="connector-card-description">{status.detail ?? t(card.summary)}</span>
                    </span>
                    <span className="connector-card-meta">
                        <span className="connector-status" data-tone={status.tone}>{t(status.label)}</span>
                        <ChevronRight className="connector-card-chevron" size={16} aria-hidden="true"/>
                    </span>
                </button>
            </li>;
        })}
    </ul>;
}

export function ConnectorsPage({ api, timeoutMs = READ_TIMEOUT_MS, verifyTimeoutMs = VERIFY_TIMEOUT_MS }: any) {
    const overview = useConnectorOverview(api, timeoutMs, verifyTimeoutMs);
    const [view, setView] = useState<string | null>(null);
    const backRef = useRef<HTMLButtonElement | null>(null);
    const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const lastOpened = useRef<string | null>(null);

    const statuses = useMemo<Record<string, ConnectorStatus>>(() => {
        const { personal, feishu } = overview;
        const personalFailed = personal.failure && !personal.pending ? failedStatus(personal.failure) : null;
        return {
            feishu: feishu.failure && !feishu.pending ? failedStatus(feishu.failure) : deriveFeishuStatus(feishu.data),
            files: personalFailed ?? deriveFilesStatus(personal.data),
            mail: personalFailed ?? deriveConnectorStatus(personal.data, MAIL_TOOLKITS),
            calendar: personalFailed ?? deriveConnectorStatus(personal.data, CALENDAR_TOOLKITS),
        };
    }, [overview.personal, overview.feishu]);
    const errors = [
        overview.personal.failure && !overview.personal.pending ? t('连接状态读取失败：{0}', t(FAILURE_REASON[overview.personal.failure])) : '',
        overview.feishu.failure && !overview.feishu.pending ? t('飞书状态读取失败：{0}', t(FAILURE_REASON[overview.feishu.failure])) : '',
    ].filter(Boolean);
    const retry = useCallback(() => { void overview.reload(); }, [overview]);

    useEffect(() => {
        if (view) {
            lastOpened.current = view;
            backRef.current?.focus();
        }
        else if (lastOpened.current) {
            const previous = lastOpened.current;
            lastOpened.current = null;
            cardRefs.current[previous]?.focus();
        }
    }, [view]);

    const closeDetail = useCallback(() => {
        setView(null);
        void overview.reload();
    }, [overview]);

    const skeleton = overview.loading && !overview.loaded;

    if (view) {
        const card = CONNECTOR_CARDS.find((candidate) => candidate.id === view);
        if (!card)
            return <p className="connectors-empty">{t('未找到该连接器，请返回后重试。')}</p>;
        const status = statuses[card.id] ?? CHECKING;
        return <div className="connector-detail" data-connector={card.id} onKeyDown={(event) => { if (event.key === 'Escape' && !(event.target instanceof HTMLElement && event.target.matches('input, textarea, select'))) { event.preventDefault(); closeDetail(); } }}>
            <div className="connector-detail-bar">
                <div className="connector-detail-crumb">
                    <button ref={backRef} type="button" className="rt-Button ghost connector-back" onClick={closeDetail}>
                        <ArrowLeft size={15} aria-hidden="true"/>{t('返回连接器')}
                    </button>
                    <span className="connector-detail-divider" aria-hidden="true">/</span>
                    <h3 id="connector-detail-title">{t(card.title)}</h3>
                </div>
                <span className="connector-status" data-tone={status.tone}>{t(status.label)}</span>
            </div>
            <div className="connector-detail-body">
                {card.panel(api)}
            </div>
        </div>;
    }

    return <div className="connectors-page">
        <div className="connectors-toolbar">
            <Button type="button" className="ghost connector-refresh" disabled={overview.loading} aria-busy={overview.loading} onClick={() => void overview.reload({ verify: true })}>
                <RefreshCw size={15} aria-hidden="true"/>{t('刷新状态')}
            </Button>
        </div>
        {errors.length > 0 && <div className="connectors-error" role="alert">
            {errors.map((message) => <p key={message}>{message}</p>)}
            <Button type="button" className="ghost connector-retry" disabled={overview.loading} onClick={retry}>{t('重试')}</Button>
        </div>}
        <ConnectorGrid statuses={statuses} loading={skeleton} onOpen={setView} onRetry={retry} cardRefs={cardRefs}/>
    </div>;
}

export default ConnectorsPage;
