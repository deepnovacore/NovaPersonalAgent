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
};
const CONNECTED = STATUS.connected!;
const CHECKING = STATUS.checking!;

export const MAIL_TOOLKITS = ['gmail', 'macos_mail'];
export const CALENDAR_TOOLKITS = ['googlecalendar', 'macos_calendar'];
const CONNECTED_FEISHU_STATES = ['ready', 'connected'];

/** Coarse Feishu status from `feishuCommand('status')` with a state fallback. */
function deriveFeishuStatus(snapshot: any): ConnectorStatus {
    if (!snapshot || typeof snapshot !== 'object')
        return CHECKING;
    if (snapshot.available === undefined && snapshot.configured === undefined && snapshot.state === undefined)
        return CHECKING;
    if (snapshot.available === false)
        return STATUS.unavailable!;
    if (snapshot.state === 'error' || snapshot.unverified === true)
        return STATUS.attention!;
    if (snapshot.auth_issue || snapshot.state === 'authorizing')
        return STATUS.authorize!;
    if (snapshot.configured !== true)
        return STATUS.setup!;
    if (snapshot.state === 'paused')
        return STATUS.paused!;
    if (snapshot.state === 'disconnected')
        return STATUS.offline!;
    if (CONNECTED_FEISHU_STATES.includes(snapshot.state))
        return snapshot.scope_configured === false ? STATUS.setup! : CONNECTED;
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
        return STATUS.offline!;
    if (sources.some((source: any) => source?.state === 'error'))
        return STATUS.attention!;
    const active = sources.filter((source: any) => source?.state !== 'disconnected');
    if (active.some((source: any) => source?.scan_pending))
        return STATUS.syncing!;
    if (active.length && active.every((source: any) => source?.state === 'paused'))
        return STATUS.paused!;
    return active.length ? CONNECTED : STATUS.offline!;
}

/** Coarse status for mail/calendar from the Composio connector snapshot. */
function deriveConnectorStatus(personal: any, toolkits: string[]): ConnectorStatus {
    if (!personal)
        return CHECKING;
    const connectors = personal.connectors;
    if (!connectors || typeof connectors !== 'object')
        return STATUS.unavailable!;
    if (connectors.memory_available === false)
        return STATUS.setup!;
    const rows = (connectors.connections ?? []).filter((connection: any) => toolkits.includes(connection?.toolkit));
    if (rows.some((connection: any) => connection?.error || connection?.state === 'error'))
        return STATUS.attention!;
    if (rows.some((connection: any) => connection?.has_pending && connection?.state === 'connected'))
        return STATUS.syncing!;
    if (rows.some((connection: any) => connection?.state === 'authorizing'))
        return STATUS.authorize!;
    if (rows.some((connection: any) => connection?.state === 'connected'))
        return CONNECTED;
    if (rows.length && rows.every((connection: any) => connection?.state === 'paused'))
        return STATUS.paused!;
    const localAvailable = toolkits === MAIL_TOOLKITS ? connectors.mail_available === true : connectors.local_available === true;
    if (connectors.available !== true && !localAvailable)
        return STATUS.unavailable!;
    return STATUS.offline!;
}

function errorMessage(result: PromiseSettledResult<any>) {
    if (result.status === 'rejected')
        return result.reason instanceof Error ? result.reason.message : '';
    const value = result.value;
    return value && typeof value === 'object' && typeof value.error === 'string' ? value.error : '';
}

/** One shared read of `personalCommand('state')` plus the Feishu snapshot for the page. */
function useConnectorOverview(api: any) {
    const [personal, setPersonal] = useState<any>(null);
    const [feishu, setFeishu] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState('');
    const mounted = useRef(true);
    const epoch = useRef(0);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            epoch.current++;
        };
    }, []);
    const read = useCallback(async (method: 'personalCommand' | 'feishuCommand', name: string) => {
        const bridge = api?.[method];
        if (typeof bridge !== 'function')
            return null;
        return bridge.call(api, name, {});
    }, [api]);
    const load = useCallback(async () => {
        const run = ++epoch.current;
        setLoading(true);
        setError('');
        const [personalResult, feishuResult] = await Promise.allSettled([
            read('personalCommand', 'state'),
            read('feishuCommand', 'feishu.status'),
        ]);
        if (!mounted.current || run !== epoch.current)
            return;
        let failed = false;
        if (personalResult.status === 'fulfilled' && personalResult.value && typeof personalResult.value === 'object' && !personalResult.value.error)
            setPersonal(personalResult.value);
        else if (personalResult.status === 'rejected' || errorMessage(personalResult))
            failed = true;
        if (feishuResult.status === 'fulfilled' && feishuResult.value && typeof feishuResult.value === 'object' && !feishuResult.value.error)
            setFeishu(feishuResult.value);
        else if (feishuResult.status === 'rejected' || errorMessage(feishuResult))
            failed = true;
        if (failed)
            setError(t('未能读取连接状态，请重试。'));
        setLoading(false);
        setLoaded(true);
    }, [read]);
    useEffect(() => {
        void load();
    }, [load]);
    return { personal, feishu, loading, loaded, error, reload: load };
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

function ConnectorGrid({ statuses, loading, onOpen, cardRefs }: any) {
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
                    onClick={() => onOpen(card.id)}
                >
                    <span className="connector-card-icon" aria-hidden="true"><Icon size={22} strokeWidth={1.8}/></span>
                    <span className="connector-card-copy">
                        <span className="connector-card-title">{t(card.title)}</span>
                        <span className="connector-card-description">{t(card.summary)}</span>
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

export function ConnectorsPage({ api }: any) {
    const overview = useConnectorOverview(api);
    const [view, setView] = useState<string | null>(null);
    const backRef = useRef<HTMLButtonElement | null>(null);
    const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const lastOpened = useRef<string | null>(null);

    const statuses = useMemo<Record<string, ConnectorStatus>>(() => {
        const feishuSnapshot = overview.feishu ?? overview.personal?.feishu;
        return {
            feishu: deriveFeishuStatus(feishuSnapshot),
            files: deriveFilesStatus(overview.personal),
            mail: deriveConnectorStatus(overview.personal, MAIL_TOOLKITS),
            calendar: deriveConnectorStatus(overview.personal, CALENDAR_TOOLKITS),
        };
    }, [overview.personal, overview.feishu]);

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
            <Button type="button" className="ghost connector-refresh" disabled={overview.loading} aria-busy={overview.loading} onClick={() => void overview.reload()}>
                <RefreshCw size={15} aria-hidden="true"/>{t('刷新状态')}
            </Button>
        </div>
        {overview.error && <p className="connectors-error" role="alert">{overview.error}</p>}
        <ConnectorGrid statuses={statuses} loading={skeleton} onOpen={setView} cardRefs={cardRefs}/>
    </div>;
}

export default ConnectorsPage;
