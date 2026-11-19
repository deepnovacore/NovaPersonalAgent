import React, { useState } from 'react';
import { t } from '../../locale.mjs';
import { formatUsageCount, formatUsageMoney, usageCostValues, usageFeatureLabels } from '../../frontend-usage.mjs';

const DIMENSIONS: [string, string][] = [['features', '按功能'], ['models', '按模型'], ['runs', '按任务']];
const COUNTERS: [string, string][] = [['requests', '调用次数'], ['missingReports', '缺少用量'], ['unpricedReports', '无法估价'], ['failedRequests', '失败调用'], ['cancelledRequests', '取消调用']];
const METERS: [string, string][] = [
    ['inputTokens', '输入词元'], ['outputTokens', '输出词元'], ['inputTextTokens', '输入文本'], ['inputAudioTokens', '输入音频'],
    ['outputTextTokens', '输出文本'], ['outputAudioTokens', '输出音频'], ['cachedTokens', '缓存命中'], ['reasoningTokens', '推理词元'],
    ['characters', '计费字符'], ['durationMs', '平均耗时'], ['audioDurationMs', '音频时长'],
];
const COUNTER_KEYS = new Set(COUNTERS.map(([key]) => key));
const OUTCOMES: Record<string, string> = { success: '成功', error: '失败', cancelled: '已取消' };

function featureLabel(feature: any) {
    return usageFeatureLabels[feature] ?? t('未分类');
}
function moneyText(view: any) {
    return usageCostValues(view).map((cost: any) => formatUsageMoney(cost.value, cost.currency)).join(' + ');
}
function UsageMoneyLines({ view }: any) {
    const costs = usageCostValues(view);
    if (!costs.length)
        return null;
    return <span className="usage-money-lines">{costs.map((cost: any) => <span className="usage-money-line" data-currency={cost.currency} key={cost.currency}>{formatUsageMoney(cost.value, cost.currency)}</span>)}</span>;
}
function meterText(key: string, value: number, requests: number) {
    if (key === 'audioDurationMs')
        return t('{0} 秒', (value / 1000).toFixed(1));
    if (key === 'durationMs')
        return t('{0} 秒', (value / Math.max(1, requests) / 1000).toFixed(2));
    return formatUsageCount(value);
}
function metric(key: string, label: string, text: string) {
    return <div className="usage-metric" key={key}><span>{t(label)}</span><strong>{text}</strong></div>;
}
function counterMetrics(view: any) {
    return <div className="usage-stats">{COUNTERS.map(([key, label]) => metric(key, label, formatUsageCount(view[key] ?? 0)))}</div>;
}
function meterMetrics(view: any) {
    const entries = METERS.filter(([key]) => view[key] !== undefined);
    if (!entries.length)
        return null;
    return <div className="usage-grid">{entries.map(([key, label]) => metric(key, label, meterText(key, Number(view[key]), Number(view.requests ?? 0))))}</div>;
}
function costMetrics(view: any) {
    const costs = usageCostValues(view);
    if (!costs.length)
        return <p className="usage-empty">{t('未估价')}</p>;
    return <div className="usage-stats usage-costs">{costs.map((cost: any) => <div className="usage-metric" key={cost.currency}><span>{t(cost.currency === 'USD' ? '美元' : '人民币')}</span><strong>{formatUsageMoney(cost.value, cost.currency)}</strong></div>)}</div>;
}
function PurposeDetail({ view }: any) {
    const partial = view.truncated || view.missingReports || view.unpricedReports;
    return <div className="usage-purpose-body">
        {partial && <span className="usage-incomplete">{t('部分用量')}</span>}
        {costMetrics(view)}
        {counterMetrics(view)}
        {meterMetrics(view)}
    </div>;
}
function UsageRowCard({ row, dimension }: any) {
    const title = dimension === 'models' ? `${row.service ?? ''} · ${row.provider ?? ''}` : featureLabel(row.feature);
    const cost = row.pricedReports ? moneyText(row) : '';
    const entries = [...COUNTERS.filter(([key]) => row[key] !== undefined), ...METERS.filter(([key]) => row[key] !== undefined)];
    return <article className="usage-card">
        <div className="usage-card-header"><div className="usage-service"><strong>{title}</strong></div><div className="usage-amount">{cost ? <UsageMoneyLines view={row}/> : <strong>{t('暂无数据')}</strong>}</div></div>
        <p className="usage-model">{row.model ?? row.runId ?? row.taskId ?? t('按功能汇总所有模型')}</p>
        {dimension === 'runs' && (row.runId || row.taskId) && <p className="usage-model">{t('任务 {0}', row.taskId ?? row.runId)}</p>}
        {entries.length ? <div className="usage-grid">{entries.map(([key, label]) => metric(key, label, COUNTER_KEYS.has(key) ? formatUsageCount(row[key] ?? 0) : meterText(key, Number(row[key]), Number(row.requests ?? 0))))}</div>
            : <p className="usage-empty">{t('服务未返回用量')}</p>}
    </article>;
}
function RecentCalls({ calls }: any) {
    return <details className="usage-recent"><summary>{t('最近 {0} 次调用', formatUsageCount(calls.length))}</summary>
        {[...calls].reverse().map((call: any, i: number) => <article className="usage-call" key={i}>
            <strong>{`${featureLabel(call.feature)} · ${call.operation ?? call.service ?? ''} · ${t(OUTCOMES[call.outcome] ?? '未知')}`}</strong>
            <p>{call.model}{call.timestamp ? ` · ${new Date(call.timestamp).toLocaleString()}` : ''}</p>
            <p>{t('输入词元')} {call.inputTokens === undefined ? '—' : formatUsageCount(call.inputTokens)} · {t('输出词元')} {call.outputTokens === undefined ? '—' : formatUsageCount(call.outputTokens)} · {call.durationMs === undefined ? '—' : formatUsageCount(call.durationMs)} ms</p>
        </article>)}
    </details>;
}
function tabKeys(keys: string[], current: string, prefix: string, select: (key: string) => void) {
    return (event: React.KeyboardEvent) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            return;
        event.preventDefault();
        const index = Math.max(0, keys.indexOf(current)), next = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : event.key === 'ArrowLeft' ? (index + keys.length - 1) % keys.length : (index + 1) % keys.length;
        select(keys[next]);
        document.getElementById(prefix + keys[next])?.focus();
    };
}
export function UsagePanel({ usage }: any) {
    const [scope, setScope] = useState('session'), [dimension, setDimension] = useState('features'), [purpose, setPurpose] = useState('all');
    const value = (scope === 'history' ? usage?.history : usage) ?? {}, requests = Number(value.requests ?? 0);
    const features = Array.isArray(value.features) ? value.features.filter((row: any) => row && typeof row.feature === 'string') : [];
    const sortedFeatures = [...features].sort((a: any, b: any) => (Number(b.requests) || 0) - (Number(a.requests) || 0));
    const purposes: any = { all: value };
    for (const row of sortedFeatures)
        purposes[row.feature] = row;
    const purposeKeys = ['all', ...sortedFeatures.map((row: any) => row.feature)];
    const activePurpose = purposeKeys.includes(purpose) ? purpose : 'all', selected = purposes[activePurpose] ?? value;
    const dimensionIds = DIMENSIONS.map(([id]) => id);
    const rows = dimension === 'runs' ? (Array.isArray(value.runs) ? value.runs : []) : (Array.isArray(value.rows) ? value.rows : []);
    const recent = Array.isArray(value.recent) ? value.recent : [];
    const visibleRecent = dimension === 'features' && activePurpose !== 'all' ? recent.filter((call: any) => call?.feature === activePurpose) : recent;
    const partial = !!(value.truncated || value.missingReports || value.unpricedReports);
    let status = t('模型调用后显示用量');
    if (usage?.persistenceError)
        status = t('历史用量读取或保存失败，当前用量仍保留。');
    else if (value.unavailable)
        status = t('读取失败');
    else if (requests > 0) {
        const total = value.pricedReports ? `${moneyText(value) || t('暂无费用数据')}${partial ? t('（部分费用）') : ''}` : t('暂不可估算');
        status = `${total} · ${t('调用 {0} 次 · 缺少用量 {1} 次 · 无法估价 {2} 次', formatUsageCount(requests), formatUsageCount(value.missingReports ?? 0), formatUsageCount(value.unpricedReports ?? 0))}`;
    }
    return <section className="setting-section" id="frontend-usage-section">
        <h2>{t('用量与费用')}</h2>
        <div className="usage-overview">{['history', 'session'].map(s => {
            const view = (s === 'history' ? usage?.history : usage) ?? {};
            const available = view.requests && !view.unavailable, costs = available ? usageCostValues(view) : [];
            return <button key={s} className="usage-scope" type="button" aria-pressed={scope === s} data-empty={available && !costs.length ? 'true' : undefined} onClick={() => setScope(s)}>
                <span>{t(s === 'history' ? '历史累计' : '本次运行')}</span>
                <strong className="usage-scope-money">{(available && costs.length) ? <UsageMoneyLines view={view}/> : available ? t('暂无费用数据') : '—'}</strong>
                <span>{view.unavailable ? t('读取失败') : t('{0} 次调用', formatUsageCount(view.requests ?? 0))}</span>
            </button>;
        })}</div>
        <p role="status">{status}</p>
        <p className="usage-note">{t('包含对话与后台任务，费用为估算值。')}</p>
        <p className="usage-note">{t('部分外部工具的用量可能未计入。')}</p>
        {value.truncated && <p className="usage-note">{t('统计已达容量上限，部分用量未计入')}</p>}
        {requests > 0 && <>
            <div className="usage-dimension-tabs" role="tablist" aria-label={t('统计维度')}>{DIMENSIONS.map(([id, label]) => <button key={id} type="button" role="tab" id={'usage-dimension-' + id} aria-selected={dimension === id} aria-controls="usage-dimension-panel" tabIndex={dimension === id ? 0 : -1} onClick={() => setDimension(id)} onKeyDown={tabKeys(dimensionIds, dimension, 'usage-dimension-', setDimension)}>{t(label)}</button>)}</div>
            <div role="tabpanel" id="usage-dimension-panel" aria-labelledby={'usage-dimension-' + dimension} className="usage-panel-body">
                {dimension === 'features' ? <>
                    <div className="usage-feature-tabs" role="tablist" aria-label={t('按功能')}>{purposeKeys.map(key => {
                        const row = purposes[key] ?? {};
                        const label = key === 'all' ? t('全部') : featureLabel(key);
                        const costs = row.pricedReports ? usageCostValues(row) : [];
                        return <button key={key} type="button" role="tab" id={'usage-purpose-' + key} aria-selected={activePurpose === key} aria-controls="usage-purpose-panel" tabIndex={activePurpose === key ? 0 : -1} className="usage-feature-tab" onClick={() => setPurpose(key)} onKeyDown={tabKeys(purposeKeys, activePurpose, 'usage-purpose-', setPurpose)}>
                            <span className="usage-feature-tab-label">{label}</span>
                            <span className="usage-feature-tab-cost">{costs.length ? <UsageMoneyLines view={row}/> : t('未估价')}</span>
                            <span className="usage-feature-tab-count">{t('{0} 次调用', formatUsageCount(row.requests ?? 0))}</span>
                            {(row.missingReports || row.unpricedReports) ? <span className="usage-feature-tab-partial" role="img" aria-label={t('部分用量')} title={t('部分用量')}/> : null}
                        </button>;
                    })}</div>
                    <div role="tabpanel" id="usage-purpose-panel" aria-labelledby={'usage-purpose-' + activePurpose} className="usage-purpose-detail">
                        <h3>{activePurpose === 'all' ? t('全部') : featureLabel(activePurpose)}</h3>
                        <PurposeDetail view={selected}/>
                    </div>
                </> : <div className="usage-cards">{rows.length ? rows.map((row: any, i: number) => <UsageRowCard key={i} row={row} dimension={dimension}/>) : <p className="usage-empty">{t('暂无该维度的用量记录')}</p>}</div>}
                {visibleRecent.length > 0 && <RecentCalls calls={visibleRecent}/>}
            </div>
        </>}
    </section>;
}
