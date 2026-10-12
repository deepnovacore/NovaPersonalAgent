/** Only result prose, never prompts, work orders or arbitrary serialized tool payloads. */
export function notificationResultText(value: unknown, fallback: string): string {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return fallback;
    const data = value as Record<string, unknown>;
    const result = data.result && typeof data.result === 'object' ? data.result as Record<string, unknown> : undefined;
    const final = result?.final_message;
    if (final && typeof final === 'object' && typeof (final as Record<string, unknown>).text === 'string')
        return String((final as Record<string, unknown>).text) + ((final as Record<string, unknown>).truncated === true ? '\n（来源结果已截断，请在 Nova 查看任务详情）' : '');
    for (const key of ['text', 'observation', 'summary', 'message'])
        if (typeof data[key] === 'string' && data[key].trim())
            return data[key];
    return fallback;
}
