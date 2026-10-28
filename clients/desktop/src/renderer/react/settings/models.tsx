import React, { useState } from 'react';
import { t } from '../../locale.mjs';

const SECRETS: Record<string, string> = {
    DASHSCOPE_API_KEY: 'dashscopeApiKey', DEEPSEEK_API_KEY: 'deepseekApiKey', OPENAI_API_KEY: 'openaiApiKey',
    GEMINI_API_KEY: 'geminiApiKey', STEPFUN_API_KEY: 'stepfunApiKey', ARK_API_KEY: 'arkApiKey',
    OPENAI_COMPATIBLE_API_KEY: 'openaiCompatibleApiKey', SELF_HOSTED_LLM_API_KEY: 'selfHostedLlmApiKey',
};
const TEXT = ['qwen', 'deepseek', 'openai', 'gemini', 'stepfun', 'ark', 'openai-compatible', 'self-hosted'];
// Keep lane admission aligned with runtime/config/model-routes and settings-store.
const LANES = [
    { id: 'conversationText', label: '对话文本', capability: 'text', providers: TEXT.filter(id => id !== 'stepfun'), follow: false },
    { id: 'support', label: '辅助与后台', capability: 'text', providers: TEXT, follow: true },
    { id: 'fast', label: '记忆提取', capability: 'text', providers: TEXT, follow: true },
    { id: 'compressor', label: '上下文压缩', capability: 'text', providers: TEXT, follow: true },
    { id: 'watch', label: '视觉监控', capability: 'vision', providers: ['qwen', 'deepseek', 'stepfun', 'ark', 'openai-compatible'], follow: false },
    { id: 'embedding', label: '知识与记忆嵌入', capability: 'embedding', providers: ['dashscope'], follow: false },
];
export function ModelRoutesPanel({ view, stage, hidden }: any) {
    const [custom, setCustom] = useState<Record<string, boolean>>({});
    const catalog = view.modelCatalog, secrets = view.secretsPresent ?? {};
    if (!catalog?.providers?.length) return <div id="model-routes" hidden={hidden}><p className="hint">{t('模型目录暂时不可用，请重启后台后重试。')}</p></div>;
    return <div id="model-routes" hidden={hidden}>{LANES.map(lane => {
        const route = view.modelRoutes?.[lane.id];
        const provider = route?.provider ?? (lane.id === 'conversationText' ? view.cascadedLlmProvider : '') ?? '';
        const model = route?.model ?? (lane.id === 'conversationText' ? view.cascadedLlmModels?.[provider] : '') ?? '';
        const providers = catalog.providers.filter((p: any) => lane.providers.includes(p.id) && p.capabilities.includes(lane.capability) && (p.id === 'self-hosted' || secrets[SECRETS[p.keyName]]));
        const choices = (id: string) => catalog.models.filter((m: any) => m.provider === id && m.capabilities.includes(lane.capability));
        const models = choices(provider), isCustom = custom[lane.id] === true || !models.some((m: any) => m.id === model);
        const save = (provider: string, model: string) => stage({ modelRoutes: { [lane.id]: provider ? { provider, model } : null }, ...(lane.id === 'conversationText' && provider ? { cascadedLlmProvider: provider, cascadedLlmModels: { [provider]: model } } : {}) });
        return <div key={lane.id} className="model-route-row" data-lane={lane.id}><div className="model-route-copy"><strong>{t(lane.label)}</strong><small>{t(lane.follow ? '默认跟随对话模型' : '用于该能力的全部调用')}</small></div><div className="model-route-controls">
            <select data-lane-provider={lane.id} aria-label={t('{0}服务商', t(lane.label))} value={provider} onChange={e => { const next = e.target.value; setCustom(c => ({ ...c, [lane.id]: false })); save(next, choices(next)[0]?.id ?? ''); }}>
                <option value="">{t(lane.follow ? '跟随对话模型' : '使用默认模型')}</option>
                {providers.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}
                {provider && !providers.some((p: any) => p.id === provider) && <option value={provider} disabled>{t('{0}（当前不可用）', provider)}</option>}
            </select>
            <select data-lane-model={lane.id} aria-label={t('{0}模型', t(lane.label))} value={isCustom ? '__custom__' : model} disabled={!provider} onChange={e => { const value = e.target.value; setCustom(c => ({ ...c, [lane.id]: value === '__custom__' })); if (value !== '__custom__') save(provider, value); }}>
                {models.map((m: any) => <option key={m.id} value={m.id}>{m.label}</option>)}<option value="__custom__">{t('自定义模型 ID…')}</option>
            </select>
            <input type="text" maxLength={256} data-lane-custom-model={lane.id} aria-label={t('{0}自定义模型 ID', t(lane.label))} placeholder={t('输入模型 ID')} hidden={!provider || !isCustom} disabled={!provider || !isCustom} required value={model} onChange={e => { const value = e.target.value; e.target.setCustomValidity(value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) ? '' : t('输入模型 ID')); save(provider, value.trim()); }}/>
        </div></div>;
    })}<p className="hint">{t('编程执行器与 ChatGPT 账号分别在「编程」「API 密钥」中配置。')}</p></div>;
}
