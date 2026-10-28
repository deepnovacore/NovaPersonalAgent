import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@radix-ui/themes';
import { Check, ExternalLink, Eye, EyeOff, KeyRound, Loader2, ShieldCheck, SlidersHorizontal, Sparkles, Zap } from 'lucide-react';
import { t } from '../locale.mjs';
const KEYS: any = { qwen: 'dashscopeApiKey', deepseek: 'deepseekApiKey', ark: 'arkApiKey' };
const LABELS: any = { dashscopeApiKey: 'DashScope API Key', deepseekApiKey: 'DeepSeek API Key', arkApiKey: '火山方舟 API Key', doubaoBigmodelApiKey: '火山语音 API Key' };
const LINKS: any = { dashscopeApiKey: 'https://bailian.console.aliyun.com/?apiKey=1&tab=model', deepseekApiKey: 'https://platform.deepseek.com/api_keys', arkApiKey: 'https://console.volcengine.com/ark/apiKey', doubaoBigmodelApiKey: 'https://console.volcengine.com/speech/new/setting/apikeys' };
const PROBE: any = { ok: '密钥有效', rejected: '密钥被拒绝，请检查是否复制完整', network: '暂时无法连接服务，请检查网络后重试', missing: '请先填写密钥', deferred: '首次连接时验证', unsupported: '' };
const PATHS = [
    ['integrated', '快速开始', '通义千问实时语音，只需一个阿里云百炼 DashScope 密钥。', Zap, true],
    ['cascaded', '高级', '火山引擎语音识别与合成，搭配你选择的大模型。', SlidersHorizontal, false],
];
const STEPS = ['选择语音方式', '连接模型服务', '开始对话'];
const closeSetupWindow = () => window.close();
export default function SetupApp({ api = (window as any).novaPersonalAgentDesktop?.setup, onClose = closeSetupWindow }: any) {
    const [view, setView] = useState<any>(null), [pipeline, setPipeline] = useState('integrated'), [provider, setProvider] = useState('deepseek'), [starting, setStarting] = useState(false), [status, setStatus] = useState(''), [tone, setTone] = useState(''), [results, setResults] = useState<any>({}), [resultTones, setResultTones] = useState<any>({}), [testing, setTesting] = useState<any>({}), [revealed, setRevealed] = useState<any>({}), [drafts, setDrafts] = useState<any>({});
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
    const keysReady = active.every(key => (drafts[key] ?? '').trim() !== '' || view?.secretsPresent?.[key] === true);
    async function test(key: string) { const rev = (probeRevision.current[key] ?? 0) + 1; probeRevision.current[key] = rev; setTesting((s: any) => ({ ...s, [key]: true })); setResults((s: any) => ({ ...s, [key]: t('测试中…') })); setResultTones((s: any) => ({ ...s, [key]: 'testing' })); try {
        const r = await api.testKey(key, inputs.current[key]?.value ?? '');
        if (alive.current && probeRevision.current[key] === rev) {
            setResults((s: any) => ({ ...s, [key]: t(PROBE[r.status] ?? PROBE.network) }));
            setResultTones((s: any) => ({ ...s, [key]: r.status === 'ok' ? 'ok' : 'warn' }));
        }
    }
    catch {
        if (alive.current) {
            setResults((s: any) => ({ ...s, [key]: t(PROBE.network) }));
            setResultTones((s: any) => ({ ...s, [key]: 'warn' }));
        }
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
        else {
            for (const key of Object.keys(secrets)) {
                if (inputs.current[key])
                    inputs.current[key]!.value = '';
                setDrafts((d: any) => ({ ...d, [key]: '' }));
            }
        }
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
    const currentStep = starting || keysReady ? 2 : 1;
    return <div className="setup-shell">
        <aside className="setup-rail">
            <div className="setup-brand"><span className="setup-brand-mark" aria-hidden="true"><Sparkles size={13}/></span><span>NOVA</span></div>
            <div className="setup-orb" aria-hidden="true"><span className="setup-orb-core"/><span className="setup-orb-ring"/></div>
            <div className="setup-rail-copy">
                <p className="setup-rail-eyebrow">{t('首次设置')}</p>
                <h1>{t('你好，我是 Nova')}</h1>
                <p>{t('一个住在你电脑里的语音搭档。')}</p>
            </div>
            <ol className="setup-steps" aria-label={t('开始步骤')}>{STEPS.map((step, index) => <li key={step} data-state={index < currentStep ? 'done' : index === currentStep ? 'current' : 'todo'} aria-current={index === currentStep ? 'step' : undefined}><span className="setup-step-index" aria-hidden="true">{index < currentStep ? <Check size={11}/> : index + 1}</span><span>{t(step)}</span></li>)}</ol>
            <p className="setup-rail-foot"><ShieldCheck size={14} aria-hidden="true"/>{t('本地优先 · 隐私可控')}</p>
        </aside>
        <main className="setup-main">
            <header className="setup-head">
                <p className="setup-eyebrow">{t('开始使用 Nova')}</p>
                <h2>{t('选择一种语音方式')}</h2>
                <p className="setup-lead">{t('填好对应密钥即可开始；之后可在设置中随时调整。')}</p>
            </header>
            <div className="setup-content">
                <div className="paths" role="radiogroup" aria-label={t('语音方式')}>{PATHS.map(([id, title, body, Icon, recommended]: any[]) => <label className="path" id={'path-' + id} key={id} data-selected={pipeline === id ? 'true' : 'false'}>
                    <input type="radio" name="pipeline" value={id} checked={pipeline === id} disabled={starting} onChange={() => setPipeline(id)}/>
                    <span className="path-icon" aria-hidden="true"><Icon size={18}/></span>
                    <span className="path-copy"><span className="path-title">{t(title)}{recommended && <span className="path-badge">{t('推荐')}</span>}</span><span className="path-body">{t(body)}</span></span>
                    <span className="path-check" aria-hidden="true"><Check size={13}/></span>
                </label>)}</div>
                {pipeline === 'cascaded' && <label className="llm-choice setup-provider"><span className="setup-field-label">{t('大模型')}</span><select id="llm-provider" value={provider} disabled={starting} onChange={e => setProvider(e.target.value)}><option value="deepseek">DeepSeek</option><option value="qwen">{t('通义千问（DashScope）')}</option><option value="ark">{t('豆包（火山方舟）')}</option></select></label>}
                <section className="fields setup-keys" id={pipeline + '-fields'} aria-labelledby="setup-keys-title">
                    <div className="setup-section-head"><div><h3 id="setup-keys-title">{t('连接模型服务')}</h3><p>{t('密钥只加密保存在本机。')}</p></div><span className="setup-secure"><ShieldCheck size={13} aria-hidden="true"/>{t('本机加密')}</span></div>
                    {Object.keys(LABELS).map(key => <div className="key-row" data-key={key} key={key} hidden={!active.includes(key)}>
                        <div className="key-label"><KeyRound size={14} aria-hidden="true"/><label htmlFor={key}>{t(LABELS[key])}</label></div>
                        <div className="key-input">
                            <input key={key} ref={el => { inputs.current[key] = el; }} id={key} type={revealed[key] ? 'text' : 'password'} autoComplete="off" spellCheck={false} onInput={() => { probeRevision.current[key] = (probeRevision.current[key] ?? 0) + 1; setResults((s: any) => ({ ...s, [key]: '' })); setResultTones((s: any) => ({ ...s, [key]: '' })); setDrafts((d: any) => ({ ...d, [key]: inputs.current[key]?.value ?? '' })); }} disabled={starting} placeholder={view?.secretsPresent?.[key] ? t('已保存，留空则继续使用') : key === 'dashscopeApiKey' ? 'sk-…' : ''}/>
                            <button type="button" className="key-reveal" aria-label={t(revealed[key] ? '隐藏密钥' : '显示密钥')} aria-pressed={revealed[key] === true} disabled={starting} onClick={() => setRevealed((s: any) => ({ ...s, [key]: !s[key] }))}>{revealed[key] ? <EyeOff size={15}/> : <Eye size={15}/>}</button>
                            {key !== 'doubaoBigmodelApiKey' && <Button type="button" className="key-test" disabled={starting || testing[key]} onClick={() => void test(key)}>{testing[key] ? <Loader2 size={14} className="setup-spinner"/> : null}{t(testing[key] ? '测试中…' : '测试')}</Button>}
                        </div>
                        <p className="key-meta"><a href={LINKS[key]} target="_blank" rel="noopener noreferrer"><ExternalLink size={12} aria-hidden="true"/>{t('获取密钥 ↗')}</a><span className="key-result" aria-live="polite" data-status={resultTones[key] || (key === 'doubaoBigmodelApiKey' ? 'deferred' : '')}>{results[key] ?? (key === 'doubaoBigmodelApiKey' ? t(PROBE.deferred) : '')}</span></p>
                    </div>)}
                </section>
                <p className="note setup-note"><ShieldCheck size={15} aria-hidden="true"/><span>{t('密钥只加密保存在本机；对话和语音会发送给你选择的模型服务商。')}<span className="setup-note-extra">{t('联网搜索等能力可以稍后在设置中开启。')}</span></span></p>
            </div>
            <footer className="setup-foot">
                <div className="setup-status"><span className="setup-status-dot" data-tone={tone || (starting ? 'busy' : keysReady ? 'ready' : 'idle')} aria-hidden="true"/><span id="status" aria-live="polite" data-tone={tone}>{status || t(keysReady ? '密钥已就绪，可以开始了' : '填好密钥后即可开始')}</span></div>
                <Button id="start" type="button" disabled={starting || !view} aria-busy={starting} onClick={() => void start()}>{starting ? <Loader2 size={16} className="setup-spinner"/> : <Check size={16}/>}{starting ? t('正在启动…') : t('开始使用 Nova')}</Button>
            </footer>
        </main>
    </div>;
}
