import React, { useCallback, useEffect, useState } from 'react';
import { Action, Card, Field } from './controls';
import { t } from '../../locale.mjs';
import { systemNotificationsView } from '../../system-notifications-view.mjs';

export function SystemNotificationsCard({ api }: any) {
    const [status, setStatus] = useState<any>(null), [busy, setBusy] = useState(false);
    const refresh = useCallback(() => { void Promise.resolve(api?.personal?.systemNotifications?.()).then(setStatus).catch(() => { }); }, [api]);
    useEffect(() => { refresh(); }, [refresh]);
    // The platform only reports a refusal when a notification is actually shown, so look again when the user comes back from the OS settings.
    useEffect(() => { window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, [refresh]);
    const view = systemNotificationsView(status, status?.platform);
    if (!api?.personal?.systemNotifications) return null;
    return <Card title="系统通知" description="提醒到达而你不在工作台前时，在桌面弹出通知；点击后回到主对话。">
        <Field label="弹出系统通知" type="checkbox" value={status ? status.enabled : true} disabled={busy || !status} onChange={(value: boolean) => { setBusy(true); void Promise.resolve(api.personal.setSystemNotifications(value)).then(refresh).catch(() => { }).finally(() => setBusy(false)); }} />
        {view.hint && <p className="personal-hint" data-tone={view.tone}>{t(view.hint)}</p>}
        {view.canOpenSettings && <Action action={() => api.personal.openNotificationSettings()}>{t('打开系统通知设置')}</Action>}
    </Card>;
}
