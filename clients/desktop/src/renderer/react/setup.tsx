import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@radix-ui/themes';
import { Check, KeyRound } from 'lucide-react';
import { t } from '../locale.mjs';
const KEYS: any = { qwen: 'dashscopeApiKey', deepseek: 'deepseekApiKey', ark: 'arkApiKey' };
const LABELS: any = { dashscopeApiKey: 'DashScope API Key', deepseekApiKey: 'DeepSeek API Key', arkApiKey: '火山方舟 API Key', doubaoBigmodelApiKey: '火山语音 API Key' };
const LINKS: any = { dashscopeApiKey: 'https://bailian.console.aliyun.com/?apiKey=1&tab=model', deepseekApiKey: 'https://platform.deepseek.com/api_keys', arkApiKey: 'https://console.volcengine.com/ark/apiKey', doubaoBigmodelApiKey: 'https://console.volcengine.com/speech/new/setting/apikeys' };
const PROBE: any = { ok: '密钥有效', rejected: '密钥被拒绝，请检查是否复制完整', network: '暂时无法连接服务，请检查网络后重试', missing: '请先填写密钥', deferred: '首次连接时验证', unsupported: '' };
const closeSetupWindow = () => window.close();
export default function SetupApp({ api = (window as any).novaPersonalAgentDesktop?.setup, onClose = closeSetupWindow }: any) {
    const [view, setView] = useState<any>(null), [pipeline, setPipeline] = useState('integrated'), [provider, setProvider] = useState('deepseek'), [starting, setStarting] = useState(false), [status, setStatus] = useState(''), [tone, setTone] = useState(''), [results, setResults] = useState<any>({}), [testing, setTesting] = useState<any>({});
    const inputs = useRef<Record<string, HTMLInputElement | null>>({}), startingRef = useRef(false), restartSeen = useRef(false), timer = useRef<any>(null), alive = useRef(true), revision = useRef(0), probeRevision = useRef<any>({});
    useEffect(() => { alive.current = true; const update = (next: any) => { revision.current++; setView(next); if (!startingRef.current)
        return; if (next.backendStatus === 'starting')
        restartSeen.current = true; if (!restartSeen.current)
        return; if (next.backendStatus === 'connected') {
        setStatus(t('已就绪，可以开始对话了'));
        setTone('ok');
        timer.current ??= setTimeout(onClose, 1200);
    }
    else if (['configuration_required', 'authentication_failed', 'unavailable'].includes(next.backendStatus)) {
        startingRef.current = false;
        setStarting(false);
        clearTimeout(timer.current);
        timer.current = null;
        setTone('warn');
        setStatus(next.backendStatus === 'configuration_required' && next.missing?.length ? t('仍缺少 {0}', next.missing.join(', ')) : t('启动失败，请检查密钥后重试'));
    } }; const off = api?.onChanged?.(update); const rev = revision.current; void api?.status?.().then((next: any) => { if (!alive.current || revision.current !== rev)
        return; setView(next); setPipeline(next.pipelineMode === 'cascaded' && ['deepseekApiKey', 'arkApiKey', 'doubaoBigmodelApiKey'].some(key => next.secretsPresent?.[key]) ? 'cascaded' : 'integrated'); if (KEYS[next.cascadedLlmProvider])
        setProvider(next.cascadedLlmProvider); }).catch(() => { if (alive.current)
        setStatus(t('读取设置失败，请重试')); }); return () => { alive.current = false; off?.(); clearTimeout(timer.current); }; }, [api, onClose]);
    const active = pipeline === 'integrated' ? ['dashscopeApiKey'] : [KEYS[provider], 'doubaoBigmodelApiKey'];
    async function test(key: string) { const rev = (probeRevision.current[key] ?? 0) + 1; probeRevision.current[key] = rev; setTesting((s: any) => ({ ...s, [key]: true })); setResults((s: any) => ({ ...s, [key]: t('测试中…') })); try {
        const r = await api.testKey(key, inputs.current[key]?.value ?? '');
        if (alive.current && probeRevision.current[key] === rev)
            setResults((s: any) => ({ ...s, [key]: t(PROBE[r.status] ?? PROBE.network) }));
    }
    catch {
        if (alive.current)
            setResults((s: any) => ({ ...s, [key]: t(PROBE.network) }));
    }
    finally {
        if (alive.current)
            setTesting((s: any) => ({ ...s, [key]: false }));
    } }
    async function start() { if (startingRef.current)
        return; const secrets: any = {}; for (const key of active) {
        const value = inputs.current[key]?.value.trim() ?? '';
        if (value)
            secrets[key] = value;
        else if (!view?.secretsPresent?.[key]) {
            setStatus(t('请填写 {0}', t(LABELS[key])));
            setTone('warn');
            inputs.current[key]?.focus();
            return;
        }
    } startingRef.current = true; restartSeen.current = false; setStarting(true); setStatus(t('正在保存并启动…')); setTone(''); clearTimeout(timer.current); timer.current = null; try {
        const result = await api.save({ pipelineMode: pipeline, ...(pipeline === 'cascaded' ? { cascadedLlmProvider: provider } : {}), secrets });
        if (!alive.current)
            return;
        if (!result.saved || result.rejectedSecrets?.length) {
            startingRef.current = false;
            setStarting(false);
            setStatus(t('密钥未能保存，请检查后重试'));
            setTone('warn');
        }
        else
            for (const key of Object.keys(secrets))
                if (inputs.current[key])
                    inputs.current[key]!.value = '';
    }
    catch {
        if (alive.current) {
            startingRef.current = false;
            setStarting(false);
            setStatus(t('保存失败，请重试'));
            setTone('warn');
        }
    }
    finally {
        for (const key of Object.keys(secrets))
            delete secrets[key];
    } }
    return <><header><span className="eyebrow">NOVA</span><h1>{t('开始使用 Nova')}</h1><p className="lead">{t('选择一种语音方式，填入它需要的密钥即可开始对话。')}</p></header><main><div className="paths" role="radiogroup" aria-label={t('语音方式')}>{[['integrated', '快速开始（推荐）', '通义千问实时语音，只需一个阿里云百炼 DashScope 密钥。'], ['cascaded', '高级', '火山引擎语音识别与合成，搭配你选择的大模型。']].map(([id, title, body]) => <label className="path" id={'path-' + id} key={id}><input type="radio" name="pipeline" value={id} checked={pipeline === id} disabled={starting} onChange={() => setPipeline(id)}/><span className="path-title">{t(title)}</span><span className="path-body">{t(body)}</span></label>)}</div>{pipeline === 'cascaded' && <label className="llm-choice">{t('大模型')}<select id="llm-provider" value={provider} disabled={starting} onChange={e => setProvider(e.target.value)}><option value="deepseek">DeepSeek</option><option value="qwen">{t('通义千问（DashScope）')}</option><option value="ark">{t('豆包（火山方舟）')}</option></select></label>}<section className="fields" id={pipeline + '-fields'}>{Object.keys(LABELS).map(key => <div className="key-row" data-key={key} key={key} hidden={!active.includes(key)}><label htmlFor={key}><KeyRound size={14}/> {t(LABELS[key])}</label><div className="key-input"><input key={key} ref={el => { inputs.current[key] = el; }} id={key} type="password" autoComplete="off" spellCheck={false} onInput={()=>{probeRevision.current[key]=(probeRevision.current[key]??0)+1;setResults((s:any)=>({...s,[key]:''}))}} disabled={starting} placeholder={view?.secretsPresent?.[key] ? t('已保存，留空则继续使用') : key === 'dashscopeApiKey' ? 'sk-…' : ''}/>{key !== 'doubaoBigmodelApiKey' && <Button type="button" disabled={starting || testing[key]} onClick={() => void test(key)}>{t('测试')}</Button>}</div><p className="key-meta"><a href={LINKS[key]} target="_blank" rel="noopener noreferrer">{t('获取密钥 ↗')}</a><span className="key-result" aria-live="polite">{results[key] ?? (key === 'doubaoBigmodelApiKey' ? t(PROBE.deferred) : '')}</span></p></div>)}</section><p className="note">{t('对话、语音与记忆内容会发送到你所选的模型服务商，密钥只加密保存在本机；联网搜索等其余能力可之后在「设置」补充。')}</p></main><footer><span id="status" aria-live="polite" data-tone={tone}>{status}</span><Button id="start" type="button" disabled={starting || !view} onClick={() => void start()}><Check size={16}/>{t('开始')}</Button></footer></>;
}
