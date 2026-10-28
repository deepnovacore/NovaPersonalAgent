import React, { useEffect, useRef, useState } from 'react';
import { Action, Field } from './controls';
import { record } from './record';
import { t } from '../../locale.mjs';
export function VoiceprintPanel({ api, view, drafts, stage }: any) { const [healthy, setHealthy] = useState(false), [checking, setChecking] = useState(false), [busy, setBusy] = useState(false), [recording, setRecording] = useState(false), [note, setNote] = useState(''); const current = useRef(view), abort = useRef<AbortController | null>(null), alive = useRef(true), epoch = useRef(0), lock = useRef(false); current.current = view; const url = view.voiceprintUploadUrl ?? '', supported = view.pipelineMode === 'cascaded' && view.cascadedAsrProvider === 'volcengine'; useEffect(() => { alive.current = true; return () => { alive.current = false; abort.current?.abort(); void api.voiceprint({ action: 'stop' }).catch(() => { }); }; }, [api]); useEffect(() => { let live = true; setHealthy(false); const rev = ++epoch.current; async function check() { if (!live)
    return; setChecking(true); try {
    const r = await api.voiceprint({ action: 'health', uploadUrl: url });
    if (live && epoch.current === rev)
        setHealthy(r.healthy === true);
}
catch {
    if (live)
        setHealthy(false);
}
finally {
    if (live)
        setChecking(false);
} } void check(); const timer = setInterval(() => void check(), 30000); return () => { live = false; clearInterval(timer); }; }, [api, url]); useEffect(() => { if (!supported)
    abort.current?.abort(); }, [supported]); async function register() { if (lock.current || !healthy)
    return; lock.current = true; setBusy(true); setRecording(true); const controller = new AbortController(); abort.current = controller; const signal = controller.signal; try {
    const started = await api.voiceprint({ action: 'start' });
    if (!started.ok)
        throw Error(started.error);
    signal.throwIfAborted();
    const audio = await record(signal, seconds => { if (alive.current)
        setNote(t('正在录音：{0}/12 秒', seconds)); });
    await api.voiceprint({ action: 'stop' });
    signal.throwIfAborted();
    abort.current = null;
    if (alive.current) {
        setRecording(false);
        setNote(t('正在注册声纹…'));
    }
    const result = await api.voiceprint({ action: 'register', audio });
    if (result.error)
        throw Object.assign(Error(result.error), { orphanedId: result.orphanedId, retainedId: result.retainedId });
    if (alive.current)
        setNote(t('声纹已注册。勾选验证并保存后生效；需要继续对话时，请重新开启麦克风。') + (result.previousDeleteFailed ? ' ' + t('旧声纹未能从火山删除，请稍后手动删除：{0}', result.previousDeleteFailed) : ''));
}
catch (e: any) {
    const messages: any = { voiceprint_rate_limited: '今日注册次数已用完或操作过于频繁，请稍后重试。', voiceprint_configuration_required: '请先保存火山语音 API Key 和上传服务地址。', voiceprint_provider_failed: '火山未能注册声纹，请检查语音服务权限或重新录音。', voiceprint_microphone_denied: '请在系统设置中允许 Nova 使用麦克风。', voiceprint_settings_changed: '注册期间语音 API Key 已更改，本次声纹已丢弃，请重新注册。' };
    if (alive.current)
        setNote(e.retainedId ? t('已保留声纹：{0}。请先恢复设置，再重试注册。', e.retainedId) : t(signal.aborted ? '已取消' : messages[e.message] ?? '声纹注册失败，请检查网络、麦克风和服务配置后重试。') + (e.orphanedId ? ' ' + t('本次声纹未能从火山删除，请稍后手动删除：{0}', e.orphanedId) : ''));
}
finally {
    await api.voiceprint({ action: 'stop' }).catch(() => { });
    abort.current = null;
    lock.current = false;
    if (alive.current) {
        setBusy(false);
        setRecording(false);
    }
} } return <section aria-label={t('声纹验证')}><h4>{t('声纹验证')}</h4><Field id="voiceprint-upload-url" label="声纹上传服务地址" type="url" value={url} disabled={busy} onChange={(value: string) => stage({ voiceprintUploadUrl: value.trim() })}/><p id="voiceprint-health" role="status">{t(!supported ? '声纹功能仅支持火山引擎 ASR。' : healthy ? '声纹服务可用' : checking ? '正在检查服务…' : '声纹服务不可用：注册入口已隐藏，声纹验证已停用。')}</p>{healthy && supported && <div id="voiceprint-controls"><p>{t('请在安静环境下独自朗读 12 秒。录音将上传至配置的服务和火山引擎用于注册；注册后清理临时录音，声纹保留在您的火山应用中。')}</p><p className="hint">{t('录音期间会暂停对话。声纹服务不可用时，自动停用声纹验证。')}</p><p id="voiceprint-reading-label">{t('请自然朗读下面这段话：')}</p><blockquote id="voiceprint-reading" aria-labelledby="voiceprint-reading-label">{t('今天的天气很晴朗，窗外的树叶随风轻轻摇动。我准备好开始新的工作，也愿意慢慢讲清楚自己的想法。')}</blockquote><p className="hint">{t('保持平时的语速和音量。读完后如仍在录音，可从头再读一遍。')}</p><p id="voiceprint-identity">{view.voiceprintId || t('尚未注册声纹')}</p><Field id="voiceprint-enabled" label="只接收已注册说话人的语音" type="checkbox" value={view.voiceprintEnabled === true} disabled={busy || !view.voiceprintId || !view.voiceprintName} onChange={(voiceprintEnabled: boolean) => stage({ voiceprintEnabled })}/><Action id="voiceprint-register" disabled={busy || Object.hasOwn(drafts, 'voiceprintUploadUrl')} action={register}>{t('录制 12 秒并注册')}</Action>{recording && <Action id="voiceprint-cancel" action={() => abort.current?.abort()}>{t('取消录音')}</Action>}</div>}<p role="status">{note}</p></section>; }
