import React, { createElement, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@radix-ui/themes';
import { Settings, Save, RefreshCw } from 'lucide-react';
import { t, currentLanguage } from '../locale.mjs';
import { createSettingsController, settingsButtonState } from '../settings-controller.mjs';
import { SETTINGS_CATEGORIES, categoryTabForKey, isValidCategory } from '../settings-categories.mjs';
import { COMPATIBLE_STAGES, COMPATIBLE_FIELDS, COMPATIBLE_PRESETS, isEndpointSecret } from '../compatible-providers.mjs';
import { SELF_HOSTED_STAGES, endpointOrigin } from '../voice-preset.mjs';
import { NATIVE_VOICE_PROVIDERS } from '../native-voice.mjs';
import { CUSTOM_VOICE_VALUE, QWEN_VOICES, QWEN_31_VOICES, STEPFUN_VOICES, VOLCENGINE_TTS_VOICES } from '../voice-choice.mjs';
import { startupMessage } from '../startup-notice.mjs';
import { settingsLayout, LayoutNode } from './settings/layout';
import { Action, Field } from './settings/controls';
import { SkinPanel, VisorPanel, PermissionsPanel, UsagePanel, SkillsPanel, KnowledgePanel, DisplayPanel } from './settings/panels';
import { ProactivityPanel, DevicePanel, ChatGptPanel } from './settings/live';
import { CapabilitiesPanel, ModuleToggle } from './settings/capabilities';
import { ConnectionsPanel, ImPanel } from './settings/integrations';
import { VoiceprintPanel } from './settings/voiceprint';
const SECRET_LABELS: any = { minicpmRealtimeApiKey: 'MiniCPM-o', personaplexRealtimeApiKey: 'PersonaPlex', openaiCompatibleApiKey: 'OpenAI-compatible LLM', compatibleAsrApiKey: 'OpenAI-compatible ASR', compatibleTtsApiKey: 'OpenAI-compatible TTS', selfHostedAsrApiKey: 'Self-hosted ASR', selfHostedLlmApiKey: 'Self-hosted LLM', selfHostedTtsApiKey: 'Self-hosted TTS', composioApiKey: 'Composio', dashscopeApiKey: 'DashScope', stepfunApiKey: 'StepFun', openaiApiKey: 'OpenAI', geminiApiKey: 'Google Gemini', tavilyApiKey: 'Tavily', openrouterApiKey: 'OpenRouter · Jev', arkApiKey: 'Ark', deepseekApiKey: 'DeepSeek（官方）', doubaoBigmodelApiKey: '火山语音' };
const ALIASES: any = { 'startup-view': 'startupView', 'wake-word-enabled': 'wakeWordEnabled', 'auto-hide-seconds': 'autoHideSeconds', 'coding-progress-narration': 'codingProgressNarration', heartbeat: 'codexHeartbeatSeconds', 'coding-provider': 'codingBackend', 'memory-prerecall-enabled': 'memoryPrerecallEnabled', 'phone-server-url': 'phoneServerUrl', 'phone-server-port': 'phoneServerPort', 'phone-server-token-file': 'phoneServerTokenFile', 'monitor-camera': 'monitorCameraDeviceId', 'watch-model': 'watchModel', 'conversation-vision-enabled': 'conversationVisionEnabled' };
const WORKSPACE_TEXT: any = { opened: '已打开当前工作区', open_failed: '系统未能打开当前工作区', cleared: '已清空工作区', cancelled: '已取消', not_managed: '当前工作区不在 Nova 工作区根目录中', empty: '没有可清空的工作区', busy: '另一项保存或维护操作正在进行', stop_failed: '后台未能安全停止，未清空工作区', clear_failed: '工作区清空未完整完成，可重试清理', restart_failed: '工作区已处理，但后台恢复失败，请重试连接', clear_and_restart_failed: '工作区清理未完整完成，后台恢复也失败；请重启后重试清理', rollback_pending: '工作区原内容尚未安全恢复，后台保持停止；请先处理回滚', cleanup_pending: '工作区清理仍在进行，请稍后重试', unavailable: '工作区维护状态暂时不可用', recovered: '工作区恢复完成，后台已开始重新连接', recovery_failed: '工作区恢复尚未完成，后台保持停止；请重试恢复' };
const NOTICE: any = { restarting: '已保存，后台正在重启并重新连接', failed: '未生效：请恢复上次可用设置，再检查未保存的草稿', restart_failed: '后端未启动：上次设置已保留，请恢复后端', recovery_pending: '上次设置已还原，请点击恢复以确认后端可用', recovery_failed: '设置恢复未完成，恢复记录已保留；若重试仍失败，请修复配置目录中的 settings.json.recovery 或配置冲突后再恢复', complete: '设置已生效' };
const GUIDANCE: any = { opencode: ['OpenCode', '配置文件', '安装 opencode-ai，并用 OpenCode 自己的登录或配置文件设置模型与凭据。'], codebuddy: ['CodeBuddy', '', '安装 @tencent-ai/codebuddy-code，并在 CodeBuddy 命令行中完成登录或密钥配置。'], pi: ['Pi', '配置目录', '安装 Pi 与 pi-acp，并在 Pi 自己的配置中设置模型与登录。Pi 不支持逐项审批，询问模式下任务会被拒绝。'], deepseek: ['DeepSeek Harness', '配置目录', '安装 @deepseek-ai/dsh，并在其配置中设置凭据；也可以使用服务配置里的 DeepSeek API Key。'] };
const toOptions = (values: any[]) => values.map(v => typeof v === 'string' ? { value: v, label: v } : v);
export default function SettingsApp({ bridge = (window as any).novaPersonalAgentDesktop, api = bridge?.settings }: any) {
    const [snapshot, setSnapshot] = useState<any>({ view: {}, drafts: {}, dirty: false, busy: false }), [category, setCategory] = useState('general'), [status, setStatus] = useState(''), [notice, setNotice] = useState(''), [workspaceNote, setWorkspaceNote] = useState(''), [maintenance, setMaintenance] = useState(false), [secretDirty, setSecretDirty] = useState<Set<string>>(new Set()), [notes, setNotes] = useState<any>({}), [cameraDevices, setCameraDevices] = useState<any[]>([]), [custom, setCustom] = useState<any>({}), [nativeVoices, setNativeVoices] = useState<any>({});
    const mounted = useRef(true), secretInputs = useRef<Record<string, HTMLInputElement | null>>({}), secretRevisions = useRef<Record<string, number>>({}), secretWrites = useRef<any>(null), writeOutcome = useRef<any>(null), categoryButtons = useRef<Record<string, HTMLButtonElement | null>>({}), maintenanceLock = useRef(false), currentView = useRef<any>({});
    currentView.current = snapshot.view;
    const controller = useMemo(() => createSettingsController({ api: { set: async (patch: any) => { const { capabilitiesDocument, capabilitiesBaseRevision, ...settingsPatch } = patch; if (secretWrites.current && Object.keys(secretWrites.current).length)
                settingsPatch.secrets = { ...secretWrites.current }; const result = await api.set({ settingsPatch, ...(capabilitiesDocument === undefined ? {} : { capabilitiesDocument, capabilitiesBaseRevision }) }); writeOutcome.current = { persisted: result?.saved !== false, rejected: result?.rejectedSecrets ?? [] }; return result; } }, render: (view: any, drafts: any, state: any) => { if (mounted.current)
            setSnapshot({ view, drafts, ...state }); }, status: (s: string) => { if (mounted.current)
            setStatus(s); }, notice: (s?: string) => { if (mounted.current)
            setNotice(s ?? ''); } } as any), [api]);
    useEffect(() => { mounted.current = true; const off = api?.onChanged?.((view: any) => { if (isValidCategory(view?.focusCategory))
        setCategory(view.focusCategory); controller.syncView(view); }); void api?.get?.().then((view: any) => { if (!mounted.current)
        return; if (isValidCategory(view?.focusCategory))
        setCategory(view.focusCategory); controller.setView(view); }).catch(() => { if (mounted.current)
        setStatus(t('读取设置失败')); }); const activity = () => bridge?.wakeWord?.activity?.(); document.addEventListener('pointerdown', activity); document.addEventListener('keydown', activity); return () => { mounted.current = false; off?.(); document.removeEventListener('pointerdown', activity); document.removeEventListener('keydown', activity); for (const input of Object.values(secretInputs.current))
        if (input)
            input.value = ''; secretWrites.current = null; }; }, [api, controller, bridge]);
    const view = snapshot.view ?? {}, stage = (patch: any) => controller.stage(patch), setNote = (id: string, value: string) => setNotes((n: any) => ({ ...n, [id]: value }));
    const buttons = settingsButtonState({ dirty: snapshot.dirty || secretDirty.size > 0, controllerBusy: snapshot.busy, lifecycleBusy: view.managedWorkspaces?.lifecycleBusy === true, workspaceBusy: maintenance, managedHealth: view.managedWorkspaces?.health, managedRecoveryStatus: view.managedWorkspaces?.recoveryStatus, currentManagedAvailable: view.managedWorkspaces?.current?.available === true, allManagedAvailable: view.managedWorkspaces?.all?.available === true });
    function markSecret(key: string) { secretRevisions.current[key] = (secretRevisions.current[key] ?? 0) + 1; setSecretDirty(s => new Set(s).add(key)); }
    async function saveAll() { if (controller.busy || secretWrites.current)
        return { saved: false, status: 'busy' }; const writes: any = {}, revisions: any = {}; for (const key of secretDirty) {
        writes[key] = secretInputs.current[key]?.value ?? '';
        revisions[key] = secretRevisions.current[key];
    } ; secretWrites.current = writes; writeOutcome.current = null; try {
        const result: any = await controller.save(writes);
        const accepted = writeOutcome.current?.persisted ? Object.keys(writes).filter(k => !writeOutcome.current.rejected.includes(k)) : [];
        for (const key of accepted) {
            if (secretRevisions.current[key] === revisions[key]) {
                if (secretInputs.current[key])
                    secretInputs.current[key]!.value = '';
                setSecretDirty(s => { const next = new Set(s); next.delete(key); return next; });
            }
        }
        if (writeOutcome.current?.rejected?.length)
            result.rejectedSecrets = writeOutcome.current.rejected;
        if (result.rejectedSecrets?.length)
            setStatus(t('部分密钥未保存(含非法字符): {0}', result.rejectedSecrets.map((k: string) => t(SECRET_LABELS[k])).join('、')));
        return result;
    }
    finally {
        for (const key of Object.keys(writes))
            delete writes[key];
        secretWrites.current = null;
    } }
    async function maintain(action: () => Promise<any>, kind = 'settings') { if (maintenanceLock.current || controller.busy)
        return; maintenanceLock.current = true; setMaintenance(true); if (kind === 'workspace')
        setWorkspaceNote(t('正在处理…')); try {
        const result = await action();
        if (kind === 'workspace') {
            setWorkspaceNote(t(WORKSPACE_TEXT[result?.status] ?? '操作未完成'));
            if (result.view)
                controller.syncView(result.view, { trackRestart: false });
        }
        else if (result) {
            controller.syncView(result, { trackRestart: false });
            setStatus(t(result.operationStatus === 'busy' ? '另一项操作进行中，请稍后重试' : result.operationStatus === 'applied' ? '后台已重启' : kind === 'restore' ? result.settingsRecoveryAvailable === false && result.settingsApplyStatus === 'applied' ? '上次设置已恢复并生效；草稿尚未保存' : '恢复未完成，请重试' : kind === 'rescan' ? (result.operationStatus === 'recovery_pending' ? 'Codex 未刷新：请先恢复上次可用设置' : result.operationStatus == null ? 'Codex 刷新完成' : 'Codex 刷新未完成') : '操作已完成'));
        }
    }
    catch {
        kind === 'workspace' ? setWorkspaceNote(t('操作未完成')) : setStatus(t('操作未完成，请重试'));
    }
    finally {
        maintenanceLock.current = false;
        if (mounted.current)
            setMaintenance(false);
    } }
    function endpointPatch(patch: any) { for (const { endpoint, secret } of COMPATIBLE_STAGES) {
        if (Object.hasOwn(patch, endpoint) && view[endpoint] !== patch[endpoint]) {
            if (secretInputs.current[secret])
                secretInputs.current[secret]!.value = '';
            markSecret(secret);
        }
    } for (const { endpoint, secret } of SELF_HOSTED_STAGES) {
        if (Object.hasOwn(patch, endpoint) && endpointOrigin(view[endpoint]) !== endpointOrigin(patch[endpoint])) {
            if (secretInputs.current[secret])
                secretInputs.current[secret]!.value = '';
            markSecret(secret);
        }
    } stage(patch); }
    function secretUsage(key: string) { if (key === 'composioApiKey')
        return t('应用连接；修改后需重启'); if (key === 'tavilyApiKey')
        return t('联网搜索'); const required = (key === 'dashscopeApiKey' && ((view.pipelineMode === 'integrated' && view.integratedProvider === 'qwen') || view.cascadedLlmProvider === 'qwen')) || (key === 'stepfunApiKey' && view.integratedProvider === 'stepfun') || (key === 'openaiApiKey' && (view.integratedProvider === 'openai' || view.cascadedLlmProvider === 'openai')) || (key === 'geminiApiKey' && [view.integratedProvider, view.cascadedLlmProvider, view.cascadedAsrProvider, view.cascadedTtsProvider].includes('gemini')) || (key === 'doubaoBigmodelApiKey' && view.pipelineMode === 'cascaded' && [view.cascadedAsrProvider, view.cascadedTtsProvider].includes('volcengine')) || COMPATIBLE_STAGES.some(({ secret, provider }: any) => key === secret && view[provider] === 'openai-compatible') || SELF_HOSTED_STAGES.some(({ secret, provider }: any) => key === secret && view[provider] === 'self-hosted') || (key === 'deepseekApiKey' && view.cascadedLlmProvider === 'deepseek') || (key === 'arkApiKey' && view.cascadedLlmProvider === 'ark'); return t(required ? '必需' : '当前未使用'); }
    const integratedModels = toOptions(NATIVE_VOICE_PROVIDERS[view.integratedProvider] ? [{ value: view.integratedProvider, label: view.integratedProvider === 'minicpm-o' ? 'MiniCPM-o 4.5' : 'PersonaPlex 7B' }] : view.integratedProvider === 'openai' ? ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'] : view.integratedProvider === 'gemini' ? ['gemini-3.8-live'] : view.integratedProvider === 'stepfun' ? ['stepaudio-3-realtime-preview'] : ['qwen-audio-3.1-realtime-plus', 'qwen-audio-3.0-realtime-plus', 'qwen-audio-3.0-realtime-flash', 'qwen3.5-omni-flash-realtime', 'qwen3.5-omni-plus-realtime']);
    if (view.integratedModel && !integratedModels.some(v => v.value === view.integratedModel))
        integratedModels.push({ value: view.integratedModel, label: view.integratedModel });
    const integratedVoices = NATIVE_VOICE_PROVIDERS[view.integratedProvider] ? toOptions(nativeVoices[view.personaplexRealtimeUrl] ?? ['NATF2']) : view.integratedProvider === 'openai' ? toOptions(['marin', 'cedar', 'alloy', 'coral']) : view.integratedProvider === 'gemini' ? toOptions(['Kore', 'Puck', 'Aoede', 'Charon', 'Fenrir']) : view.integratedProvider === 'stepfun' ? STEPFUN_VOICES : view.integratedModel?.startsWith('qwen3.5-omni-') ? toOptions(['Ethan']) : view.integratedModel === 'qwen-audio-3.1-realtime-plus' ? QWEN_31_VOICES : QWEN_VOICES;
    const modelOptions = toOptions(({ qwen: ['qwen3.8-flash', 'qwen-flash', 'qwen3.8-max', 'qwen-plus'], openai: ['gpt-6-luna'], gemini: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'], deepseek: ['deepseek-flash'], ark: ['doubao-seed-2-0-pro-260215'] } as any)[view.cascadedLlmProvider] ?? []), ttsVoices = view.cascadedTtsProvider === 'gemini' ? toOptions(['Kore', 'Puck', 'Aoede', 'Charon', 'Fenrir']) : VOLCENGINE_TTS_VOICES;
    const pickers: any = { integratedVoicePreset: { field: 'integratedVoice', options: integratedVoices, custom: 'integratedVoiceCustom' }, cascadedLlmModelPreset: { field: 'cascadedLlmModels', options: modelOptions, custom: 'cascadedLlmModel' }, cascadedTtsVoicePreset: { field: view.cascadedTtsProvider === 'gemini' ? 'geminiTtsVoice' : 'cascadedTtsVoice', options: ttsVoices, custom: 'cascadedTtsVoiceCustom' } };
    function picker(id: string) { const p = pickers[id], v = p.field === 'cascadedLlmModels' ? view.cascadedLlmModels?.[view.cascadedLlmProvider] : view[p.field]; const isCustom = custom[id] === true || !p.options.some((o: any) => o.value === v); return <React.Fragment key={id}><select id={id} value={isCustom ? CUSTOM_VOICE_VALUE : v ?? ''} onChange={e => { const v = e.target.value; setCustom((c: any) => ({ ...c, [id]: v === CUSTOM_VOICE_VALUE })); if (v !== CUSTOM_VOICE_VALUE)
        stage(p.field === 'cascadedLlmModels' ? { cascadedLlmModels: { [view.cascadedLlmProvider]: v } } : { [p.field]: v }); }}>{[...p.options, { value: CUSTOM_VOICE_VALUE, label: t(id === 'cascadedLlmModelPreset' ? '自定义模型 ID…' : '自定义音色 ID…') }].map((o: any) => <option key={o.value} value={o.value}>{t(o.label)}</option>)}</select><input id={p.custom} type="text" hidden={!isCustom} maxLength={id === 'cascadedLlmModelPreset' && view.cascadedLlmProvider === 'openai-compatible' ? 256 : 64} aria-label={t(id === 'cascadedLlmModelPreset' ? '自定义对话模型 ID' : id === 'integratedVoicePreset' ? 'Qwen 自定义音色 ID' : 'TTS 自定义音色 ID')} value={v ?? ''} onChange={e => stage(p.field === 'cascadedLlmModels' ? { cascadedLlmModels: { [view.cascadedLlmProvider]: e.target.value } } : { [p.field]: e.target.value })}/></React.Fragment>; }
    const visibleSections = new Set(SETTINGS_CATEGORIES.find((c: any) => c.id === category)?.sections ?? []), allSections = new Set(SETTINGS_CATEGORIES.flatMap((c: any) => c.sections));
    function renderNode(node: LayoutNode, index = 0): React.ReactNode {
        if (typeof node === 'string')
            return t(node);
        const { tag, props, children } = node, id = props.id ?? '', key = id || index;
        const categoryHidden = allSections.has(id) && !visibleSections.has(id);
        const active = !categoryHidden;
        if (id === 'visor-section')
            return category === 'themes' ? <VisorPanel key={key} api={bridge?.visor}/> : null;
        if (id === 'orb-skin-section')
            return category === 'themes' ? <SkinPanel key={key} view={view} stage={stage} discard={controller.discardFields} busy={snapshot.busy}/> : null;
        if (id === 'frontend-usage-section')
            return category === 'usage' ? <UsagePanel key={key} usage={view.frontendUsage}/> : null;
        if (id === 'hub-connection-section')
            return category === 'hub' ? <DevicePanel key={key} hub api={api}/> : null;
        if (id === 'phone-connection-section')
            return category === 'phone' ? <DevicePanel key={key} api={api} save={saveAll}>{['phoneServerUrl', 'phoneServerPort', 'phoneServerTokenFile'].map((f, i) => <Field key={f} label={['自定义地址', '已有服务端口', '认证文件'][i]} type={i === 1 ? 'number' : 'text'} value={view[f] ?? ''} min={i === 1 ? 1 : undefined} max={i === 1 ? 65535 : undefined} onChange={(v: any) => stage({ [f]: v })}/>)}</DevicePanel> : null;
        if (id === 'desktop-permissions-panel')
            return category === 'connections' ? <PermissionsPanel key={key} api={bridge?.welcome}/> : null;
        if (id === 'connections-panel')
            return category === 'connections' ? <ConnectionsPanel key={key} api={api}/> : null;
        if (id === 'im-connection')
            return category === 'im' ? <ImPanel key={key} api={api}/> : null;
        if (id === 'proactivity-panel' || id === 'diary-panel')
            return category === (id === 'diary-panel' ? 'diary' : 'general') ? <ProactivityPanel key={key} api={api} diary={id === 'diary-panel'} keyMissing={!view.secretsPresent?.openrouterApiKey} memory={view.capabilities?.runtime?.modules?.memory}/> : null;
        if (id === 'capabilities-editor')
            return category === 'capabilities' ? <CapabilitiesPanel key={key} view={view} stage={stage} api={api}/> : null;
        if (id === 'camera-executor-toggle' || id === 'coding-executor-toggle')
            return <ModuleToggle key={key} name={id.startsWith('camera') ? 'camera' : 'coding'} label={id.startsWith('camera') ? '视觉监控' : '编程'} view={view} stage={stage}/>;
        if (id === 'knowledge-panel')
            return category === 'knowledge' ? <KnowledgePanel key={key} api={api} view={view}/> : null;
        if (id === 'skills-panel')
            return category === 'skills' ? <SkillsPanel key={key} api={api} skills={view.skills}/> : null;
        if (id === 'chatgpt-settings')
            return category === 'secrets' ? <ChatGptPanel key={key} api={bridge?.chatgpt}/> : null;
        if (id === 'voiceprint-settings' || (tag === 'section' && props['aria-label'] === '声纹验证'))
            return category === 'pipeline' ? <VoiceprintPanel key={key} api={api} view={view} drafts={snapshot.drafts} stage={stage}/> : null;
        if (id === 'display-steps')
            return <DisplayPanel key={key}/>;
        if (id === 'display-collapse' || (tag === 'label' && ['display-steps', 'display-collapse'].includes(props.for ?? '')))
            return null;
        if (pickers[id])
            return picker(id);
        if (Object.values(pickers).some((p: any) => p.custom === id))
            return null;
        const p: any = { key };
        const names: any = { class: 'className', for: 'htmlFor', tabindex: 'tabIndex', maxlength: 'maxLength', autocomplete: 'autoComplete', spellcheck: 'spellCheck', 'stroke-width': 'strokeWidth', 'stroke-linecap': 'strokeLinecap', 'stroke-linejoin': 'strokeLinejoin', viewbox: 'viewBox' };
        for (const [k, v] of Object.entries(props)) {
            if (k === 'selected' || k === 'checked' || k === 'hidden' || k === 'disabled' || k === 'value')
                continue;
            p[names[k] ?? k] = v === null ? true : typeof v === 'string' && ['title', 'placeholder', 'aria-label', 'alt'].includes(k) ? t(v) : v;
        }
        if (tag === 'option' && props.value !== undefined)
            p.value = props.value;
        if (categoryHidden)
            p.hidden = true;
        else if (Object.hasOwn(props, 'hidden'))
            p.hidden = true;
        if (allSections.has(id))
            p.hidden = categoryHidden;
        if(props['data-endpoint']&&secretUsage(props['data-endpoint'])===t('必需'))p.open=true; if(id==='secrets-advanced')p.open=true; if(props.class==='secret'&&secretUsage(props['data-key']??'')===t('必需'))p['data-required']='true'; if (id === 'secrets' || id === 'codex-projects')
            p.open = true;
        const hidden: any = { 'language-restart-hint': (view.language ?? 'zh-CN') === currentLanguage(), 'codex-manual-settings': view.codexBinaryMode !== 'manual', 'codex-rescan': view.codexBinaryMode === 'manual', 'codex-yolo-warning': view.codexApprovalMode !== 'yolo', 'integrated-pipeline': view.pipelineMode !== 'integrated', 'cascaded-pipeline': view.pipelineMode !== 'cascaded', 'gemini-live-limit': view.integratedProvider !== 'gemini', 'gemini-asr-settings': view.cascadedAsrProvider !== 'gemini', 'gemini-tts-settings': view.cascadedTtsProvider !== 'gemini', 'cascaded-tts-voice-settings': ['self-hosted', 'openai-compatible'].includes(view.cascadedTtsProvider), 'keyring-warning': view.keyringAvailable !== false, 'wake-word-retry': view.wakeWord?.status !== 'error', 'wake-word-status': !['error', 'loading'].includes(view.wakeWord?.status), 'workspace-retry-recovery': (view.managedWorkspaces?.recoveryStatus ?? 'idle') === 'idle', 'codex-discovery': !!GUIDANCE[view.codingBackend], 'codex-status': !!GUIDANCE[view.codingBackend], 'coding-acp-settings': !GUIDANCE[view.codingBackend], 'coding-config-field': !GUIDANCE[view.codingBackend]?.[1] };
        for (const { stage: s, provider } of COMPATIBLE_STAGES)
            hidden[`compatible-${s}-settings`] = view[provider] !== 'openai-compatible';
        for (const { stage: s, provider } of SELF_HOSTED_STAGES)
            hidden[`self-hosted-${s}-settings`] = view[provider] !== 'self-hosted';
        for (const native of Object.keys(NATIVE_VOICE_PROVIDERS))
            hidden['native-' + native] = view.integratedProvider !== native;
        if(props.class==='field'&&children.some((n:any)=>typeof n!=='string'&&n.props.for==='integratedVoicePreset'))p.hidden=view.integratedProvider==='minicpm-o'; if (Object.hasOwn(hidden, id))
            p.hidden = hidden[id];
        const text: any = { 'heartbeat-value': t('{0} 秒', view.codexHeartbeatSeconds ?? 30), 'effective-workspace': view.effectivePaths?.workspace ?? '', 'effective-managed-root': view.effectivePaths?.managedRoot ?? '', 'codex-status': view.codexStatus?.status === 'ready' ? t('已连接 {0}', view.codexStatus.version) : t('未找到可用的 Codex CLI；可刷新或指定完整路径，Windows 支持 npm 安装的 codex.cmd。'), 'workspace-action-status': workspaceNote || t((view.managedWorkspaces?.recoveryStatus ?? 'idle') !== 'idle' ? '工作区原内容尚未安全恢复，后台保持停止；请先处理回滚' : ''), 'wake-word-status': t(view.wakeWord?.status === 'loading' ? '正在准备唤醒模型…' : view.wakeWord?.status === 'error' ? '唤醒模型不可用，请重试；可用托盘显示窗口。' : ''), 'capabilities-problems': (view.capabilities?.problems ?? []).join(' · '), 'coding-backend-title': GUIDANCE[view.codingBackend] ? t('{0} 配置', GUIDANCE[view.codingBackend][0]) : '', 'coding-backend-guidance': GUIDANCE[view.codingBackend] ? t(GUIDANCE[view.codingBackend][2]) : '', 'coding-config-label': GUIDANCE[view.codingBackend]?.[1] ?? '', 'coding-permission-note': view.codingBackend === 'pi' ? t('Pi 不支持逐项审批：询问模式下任务会被拒绝，不会自动改为 YOLO。') : GUIDANCE[view.codingBackend] ? t('审批由所选执行器在任务开始时协商；不支持当前审批模式时任务会被拒绝。') : '', 'coding-backend-status': view.codingBackends?.[view.codingBackend]?.binary === 'available' ? t('已找到可执行文件；登录状态尚未验证，会在任务开始时检查。') : t('未找到可执行文件，请安装或指定路径'), ...notes };
        if (id.startsWith('badge-')) {
            const sk = id.slice(6), stored = view.secretsPresent?.[sk] === true, source = view.secretSources?.[sk];
            text[id] = t(source === 'dotenv' && !isEndpointSecret(sk) ? '来自 .env' : stored ? source === 'environment' ? '来自系统配置' : '已设置' : '未设置');
            p['data-present'] = stored ? '1' : '0';
        }
        if (id.startsWith('usage-') && SECRET_LABELS[id.slice(6)])
            text[id] = secretUsage(id.slice(6));
        if (id.startsWith('secret-tab-')) {
            const tab = id.slice(11);
            p['aria-selected'] = (custom.secretTab ?? 'models') === tab;
            p.tabIndex = p['aria-selected'] ? 0 : -1;
            p.onClick = () => setCustom((c: any) => ({ ...c, secretTab: tab }));
            p.onKeyDown = (e: any) => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const next = e.key === 'Home' ? 'models' : e.key === 'End' ? 'connections' : tab === 'models' ? 'connections' : 'models';
                setCustom((c: any) => ({ ...c, secretTab: next }));
                document.getElementById('secret-tab-' + next)?.focus();
            } };
        }
        if (id.startsWith('secret-panel-'))
            p.hidden = (custom.secretTab ?? 'models') !== id.slice(13);
        if (tag === 'input' && props.type === 'password') {
            const source = view.secretSources?.[id], fromFile = source === 'dotenv' && !isEndpointSecret(id);
            p.ref = (el: HTMLInputElement | null) => { secretInputs.current[id] = el; };
            p.autoComplete = 'off';
            p.defaultValue = '';
            p.hidden = view.secretsPresent?.[id] === true && !secretDirty.has(id);
            p.disabled = fromFile;
            p.placeholder = t(fromFile ? '在 repo .env 中修改，重启后生效' : '输入新密钥');
            p.onInput = () => markSecret(id);
            return createElement(tag, p);
        }
        if (tag === 'button' && props.class === 'clear') {
            const sk = props['data-key']!;
            p.disabled = view.secretSources?.[sk] === 'dotenv' && !isEndpointSecret(sk);
            p.onClick = () => { const input = secretInputs.current[sk]; if (input) {
                input.value = '';
                input.hidden = false;
                input.focus();
            } markSecret(sk); };
        }
        if (['input', 'select', 'textarea'].includes(tag) && props.type !== 'password') {
            const field = ALIASES[id] ?? props.name ?? id;
            if (props.type === 'radio') {
                p.checked = view[field] === props.value;
                p.value = props.value;
                p.onChange = () => stage({ [field]: props.value });
            }
            else {
                const checkbox = props.type === 'checkbox';
                let value = field === 'generatePlan' ? view[field] !== false : view[field] ?? (props.value ?? '');
                if (id === 'coding-binary-path')
                    value = view.codingBackendPaths?.[view.codingBackend]?.binaryPath ?? '';
                if (id === 'coding-config-path')
                    value = view.codingBackendPaths?.[view.codingBackend]?.configPath ?? '';
                if (checkbox)
                    p.checked = value === true;
                else
                    p.value = value;
                p.onChange = (e: any) => { let value = checkbox ? e.target.checked : ['number', 'range'].includes(props.type ?? '') ? Number(e.target.value) : e.target.value; if (id === 'auto-hide-seconds') {
                    const valid = Number.isInteger(value) && (value === 0 || value >= 30 && value <= 3600);
                    e.target.setCustomValidity(valid ? '' : t('请输入 0 或 30–3600 的整数'));
                    if (!valid) {
                        e.target.reportValidity();
                        return;
                    }
                } if (id === 'coding-binary-path' || id === 'coding-config-path') {
                    stage({ codingBackendPaths: { [view.codingBackend]: { [id === 'coding-binary-path' ? 'binaryPath' : 'configPath']: value } } });
                    return;
                } if (id === 'integratedProvider') {
                    const native = NATIVE_VOICE_PROVIDERS[value];
                    stage({ integratedProvider: value, integratedModel: native?.model ?? ({ openai: 'gpt-realtime-2.1-mini', gemini: 'gemini-3.8-live', stepfun: 'stepaudio-3-realtime-preview' } as any)[value] ?? 'qwen-audio-3.0-realtime-plus', integratedVoice: native?.voice ?? ({ openai: 'marin', gemini: 'Kore', stepfun: 'default' } as any)[value] ?? 'longanqian' });
                    setCustom({});
                    return;
                } if (id === 'integratedModel') {
                    stage({ integratedModel: value, ...(!NATIVE_VOICE_PROVIDERS[view.integratedProvider] && value !== view.integratedModel ? { integratedVoice: ({ openai: 'marin', gemini: 'Kore', stepfun: 'default' } as any)[view.integratedProvider] ?? (value.startsWith('qwen3.5-omni-') ? 'Ethan' : value === 'qwen-audio-3.1-realtime-plus' ? 'longanqian_v3.1' : 'longanqian') } : {}) });
                    return;
                } if (id === 'conversation-vision-enabled') {
                    void (async () => { try {
                        if (value && await bridge.camera.requestPermission() !== 'granted')
                            throw Error();
                        if (currentView.current.pipelineMode === 'cascaded')
                            stage({ conversationVisionEnabled: value });
                    }
                    catch {
                        setNote('conversation-vision-status', t('摄像头权限未授予'));
                    } })();
                    return;
                } endpointPatch({ [field]: value }); };
            }
            if (id === 'codexBinaryPath')
                p.disabled = view.codexBinaryMode !== 'manual';
            if (id === 'conversation-vision-enabled') {
                const supported = view.pipelineMode === 'cascaded' && view.visionModels?.[view.cascadedLlmProvider]?.includes(view.cascadedLlmModels?.[view.cascadedLlmProvider]);
                p.disabled = !supported;
                p.checked = !!supported && view.conversationVisionEnabled === true;
            }
            if (id.startsWith('compatible-') && id.endsWith('-preset')) {
                const s = id.split('-')[1], profile = COMPATIBLE_STAGES.find((v: any) => v.stage === s)!;
                p.value = custom[id] ?? '';
                p.onChange = (e: any) => { setCustom((c: any) => ({ ...c, [id]: e.target.value })); const preset = COMPATIBLE_PRESETS[s].find((v: any) => v.id === e.target.value); if (!preset)
                    return; endpointPatch({ [profile.endpoint]: preset.baseUrl, ...(profile.model ? { [profile.model]: preset.model } : {}), ...(s === 'llm' ? { openaiCompatibleProtocol: preset.protocol, cascadedLlmModels: { 'openai-compatible': '' } } : s === 'asr' ? { compatibleAsrOmitResponseFormat: preset.omitResponseFormat === true } : { compatibleTtsVoice: preset.voice, compatibleTtsSendSampleRate: preset.sendSampleRate }) }); };
                return createElement('select', p, <option value="">{t('自定义')}</option>, ...COMPATIBLE_PRESETS[s].map((v: any) => <option key={v.id} value={v.id}>{t(v.label)}</option>));
            }
            if (id === 'integratedModel')
                return createElement('select', p, ...integratedModels.map(v => <option key={v.value} value={v.value}>{v.label}</option>));
            if (id === 'monitor-camera') {
                p.disabled = view.capabilitiesDocument?.modules?.camera?.enabled === false;
                const rows = [{ deviceId: '', label: t('系统默认摄像头') }, ...cameraDevices];
                if (view.monitorCameraDeviceId && !rows.some(r => r.deviceId === view.monitorCameraDeviceId))
                    rows.push({ deviceId: view.monitorCameraDeviceId, label: t('已选摄像头（未检测到）') });
                return createElement('select', p, ...rows.map(v => <option key={v.deviceId} value={v.deviceId}>{v.label}</option>));
            }
            if (id === 'watch-model') {
                const rows = Object.entries(view.visionModels ?? {}).flatMap(([provider, models]: any) => view.secretsPresent?.[({ qwen: 'dashscopeApiKey', ark: 'arkApiKey' } as any)[provider]] ? models.map((model: string) => ({ value: model, label: `${provider === 'qwen' ? 'Qwen' : t('豆包')} · ${model}` })) : []);
                p.disabled = view.capabilitiesDocument?.modules?.camera?.enabled === false || !rows.length;
                return createElement('select', p, <option value="" disabled>{t(rows.length ? '选择监控模型' : '请先配置视觉模型 API Key')}</option>, ...rows.map(r => <option key={r.value} value={r.value}>{r.label}</option>), view.watchModel && !rows.some(r => r.value === view.watchModel) ? <option disabled value={view.watchModel}>{t('{0}（当前不可选）', view.watchModel)}</option> : null);
            }
        }
        const actions: any = { 'coding-executor-configure': () => setCategory('codex'), 'wake-word-retry': () => bridge?.wakeWord?.retry?.(), 'codex-rescan': () => maintain(() => api.rescanCodex(), 'rescan'), 'projects-repair': async () => { const results = await Promise.all(['state', 'managed', 'workspace'].map(root => api.repairProjects(root))); setStatus(t(results.every(r => r?.status === 'ok') ? 'Projects 目录权限已修复' : '部分 Projects 目录无法修复，请检查路径是否存在')); }, 'workspace-open-current': () => maintain(() => api.openCurrentManagedWorkspace(), 'workspace'), 'workspace-clear-current': () => maintain(() => api.clearCurrentManagedWorkspace(), 'workspace'), 'workspace-clear-all': () => maintain(() => api.clearAllManagedWorkspaces(), 'workspace'), 'workspace-retry-recovery': () => maintain(async () => { const v = await api.retryBackend(); return { view: v, status: v?.managedWorkspaces?.recoveryStatus === 'idle' ? 'recovered' : 'recovery_failed' }; }, 'workspace'), 'camera-refresh': async () => { try {
                const devices = await bridge.camera.listDevices();
                setCameraDevices(devices);
                setNote('camera-devices-status', devices.length ? '' : t('未检测到摄像头；授权并连接设备后重试'));
            }
            catch {
                setNote('camera-devices-status', t('无法获取摄像头列表'));
            } } };
        if (id.startsWith('voice-preset-') && ['import', 'export'].includes(id.slice(13)))
            actions[id] = async () => { const action = id.slice(13); try {
                const r = await api.voicePreset(action, action === 'export' ? controller.snapshot().view : undefined);
                if (r.canceled)
                    return;
                if (r.error)
                    throw Error();
                if (r.patch)
                    endpointPatch(r.patch);
                const hosts = [...new Set(SELF_HOSTED_STAGES.filter(({ endpoint }: any) => r.patch?.[endpoint]).map(({ endpoint }: any) => new URL(r.patch[endpoint]).host))];
                setNote('voice-preset-status', t(action === 'import' ? '预设已导入，请保存。' : '语音预设已导出（不含密钥）。') + (hosts.length ? ' → ' + hosts.join(', ') : ''));
            }
            catch {
                setNote('voice-preset-status', t('预设操作失败：请检查 JSON 版本、地址和模型；至少选择一个支持的完整阶段。'));
            } };
        if (id.startsWith('probe-') && !id.startsWith('probe-status-'))
            actions[id] = async () => { const provider = id.slice(6); setNote('probe-status-' + provider, t('正在检查服务…')); try {
                const r = await api.nativeVoiceCapabilities(provider);
                if (provider === 'personaplex')
                    setNativeVoices((v: any) => ({ ...v, [r.endpoint]: r.voices }));
                setNote('probe-status-' + provider, t('服务已就绪'));
            }
            catch {
                setNote('probe-status-' + provider, t('无法确认服务能力，请先保存设置，并检查服务地址、连接和密钥。'));
            } };
        if (actions[id]) {
            const disabled = id === 'workspace-clear-all' ? buttons.workspaceDisabled : ['workspace-open-current', 'workspace-clear-current'].includes(id) ? buttons.currentDisabled : id === 'workspace-retry-recovery' ? buttons.recoveryDisabled : id === 'camera-refresh' ? view.capabilitiesDocument?.modules?.camera?.enabled === false : snapshot.busy || maintenance;
            return <Action {...p} disabled={disabled} action={actions[id]}>{children.map(renderNode)}</Action>;
        }
        if (Object.hasOwn(text, id))
            return createElement(tag, p, text[id]);
        return createElement(tag, p, ...children.map(renderNode));
    }
    return <><header><div className="title-lockup"><span className="eyebrow">NOVA</span><h1><Settings size={23}/> {t('设置')}</h1></div><div><p id="startup-status" role="status">{startupMessage(view.startup)}</p>{view.startup?.stage === 'failed' && <Action disabled={snapshot.busy || maintenance} action={() => maintain(() => api.retryBackend(), 'restore')}>{t('重试')}</Action>}</div><span id="status" aria-live="polite">{status}</span></header><nav className="settings-nav" id="settings-nav" aria-label={t('设置分类')}>{SETTINGS_CATEGORIES.map((c: any) => <button key={c.id} ref={el => { categoryButtons.current[c.id] = el; }} type="button" className="nav-item" id={'category-' + c.id} aria-current={category === c.id ? 'true' : 'false'} tabIndex={category === c.id ? 0 : -1} onClick={() => setCategory(c.id)} onKeyDown={e => { const next = categoryTabForKey(category, e.key); if (next) {
        e.preventDefault();
        setCategory(next);
        categoryButtons.current[next]?.focus();
    } }}>{c.label}</button>)}</nav>{settingsLayout.map(renderNode)}<footer hidden={category === 'phone' || category === 'hub'}><div className="footer-copy"><p className="note">{t('服务配置保存后，点击重启生效。')}</p>{(notice || ['recovery_pending', 'recovery_failed'].includes(view.settingsApplyStatus)) && <p id="restart-notice" className="warning" role="status">{t(NOTICE[['recovery_pending', 'recovery_failed'].includes(view.settingsApplyStatus) ? view.settingsApplyStatus : notice] ?? '设置已生效')}</p>}</div>{view.settingsRecoveryAvailable && <Action id="settings-restore" disabled={snapshot.busy || maintenance || view.managedWorkspaces?.lifecycleBusy} action={() => maintain(() => api.retryBackend(), 'restore')}>{t('恢复上次可用设置')}</Action>}<Button id="settings-save" type="button" disabled={buttons.saveDisabled} onClick={() => void saveAll()}><Save size={15}/>{t('保存')}</Button><Button id="settings-restart" type="button" disabled={snapshot.busy || maintenance || view.managedWorkspaces?.lifecycleBusy} onClick={() => void maintain(() => api.restart())}><RefreshCw size={15}/>{t('重启')}</Button></footer></>;
}
