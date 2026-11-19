// Nova SDK patch, Apache-2.0. This is a deliberately closed grammar, not a
// keyword classifier: the entire source must be an attributed standing claim.
export const REPLY_PREFERENCE_PROTOCOL = 'voicemem-0.0.1/grounded-reply-preferences-v1';
const dimensions = {
    length: { brief: 'Prefers brief replies', detailed: 'Prefers detailed replies' },
    directness: { direct: 'Prefers direct replies', indirect: 'Prefers indirect replies' },
};
const terms = new Map([
    ['简洁', ['length', 'brief']], ['简短', ['length', 'brief']], ['精简', ['length', 'brief']],
    ['详细', ['length', 'detailed']], ['详尽', ['length', 'detailed']],
    ['直接', ['directness', 'direct']], ['委婉', ['directness', 'indirect']],
    ['concise', ['length', 'brief']], ['brief', ['length', 'brief']], ['short', ['length', 'brief']],
    ['detailed', ['length', 'detailed']], ['thorough', ['length', 'detailed']],
    ['direct', ['directness', 'direct']], ['indirect', ['directness', 'indirect']],
]);
export function groundedReplyPreferences(source) {
    if (source.audioEvidence || (source.role ?? 'user') !== 'user') return [];
    const text = source.text.trim();
    // No arbitrary surrounding prose, quotations, negation, modality or third-party
    // context is admitted. Optional tail must itself explicitly assert permanence.
    const deniedZh = /^我(?:(?:一贯|一直|始终|通常))?(?:不喜欢|不偏好|不再喜欢|不再偏好)([\u4e00-\u9fff、和且及]+)的(?:回答|回复|答复)[。！.!]?$/u.exec(text);
    const deniedEn = /^I (?:(?:always|consistently|generally) )?(?:do not|don't|no longer) (?:prefer|like) ([a-z ,]+) (?:answers|replies|responses)[.!]?$/iu.exec(text);
    const polarity = deniedZh || deniedEn ? 'denied' : 'affirmed';
    const zh = deniedZh ?? /^我(?:一贯|一直|始终|通常)(?:更)?(?:喜欢|偏好)([\u4e00-\u9fff、和且及]+)的(?:回答|回复|答复)(?:[，,](?:这是一项|这是我的)(?:长期沟通偏好|长期偏好))?[。！.!]?$/u.exec(text);
    const en = deniedEn ?? /^I (?:always|consistently|generally) prefer ([a-z ,]+) (?:answers|replies|responses)(?:[,.] (?:this is a|this is my) (?:standing|long-term) (?:communication )?preference)?[.!]?$/iu.exec(text);
    if (!zh && !en) return [];
    const adjectives = zh ? zh[1].split(/[、和且及]/u).flatMap(part => {
        // Chinese can concatenate adjectives without a conjunction. Consume every
        // character; unknown material invalidates the whole assertion.
        const result = [];
        while (part) {
            const term = [...terms.keys()].find(key => /[\u4e00-\u9fff]/u.test(key) && part.startsWith(key));
            if (!term) return [''];
            result.push(term); part = part.slice(term.length);
        }
        return result;
    }) : en[1].toLowerCase().split(/\s*(?:,\s*(?:and\s+)?|\band\b)\s*/u);
    if (!adjectives.length || adjectives.some(term => !terms.has(term))) return [];
    const claims = new Map();
    for (const term of adjectives) {
        const [dimension, value] = terms.get(term);
        if (claims.has(dimension) && claims.get(dimension) !== value) return [];
        claims.set(dimension, value);
    }
    return [...claims].map(([dimension, value]) => ({
        protocol: REPLY_PREFERENCE_PROTOCOL, dimension, value, polarity,
        support: { text, start: source.text.indexOf(text), end: source.text.indexOf(text) + text.length },
    }));
}
const attribute = claim => `reply_preference:v1:${claim.dimension}:${claim.value}:${claim.polarity}`;
const display = claim => claim.polarity === 'denied' ? `Rejects ${claim.dimension}=${claim.value} replies` : dimensions[claim.dimension][claim.value];
export function replyPreferenceTrait(claim, subject) {
    return { text: display(claim), subject,
        attribute: attribute(claim),
        slots: ['表达风格'], entities: [], emotion: '', replyPreference: claim };
}
function supported(record, store) {
    const claim = record.replyPreference;
    if (!claim || claim.protocol !== REPLY_PREFERENCE_PROTOCOL || record.sourceRole === 'assistant' ||
        record.subject !== record.userId || (record.attributedTo !== undefined && record.attributedTo !== record.userId) ||
        !dimensions[claim.dimension]?.[claim.value] || !['affirmed', 'denied'].includes(claim.polarity) || record.attribute !== attribute(claim) ||
        record.text !== display(claim) || !record.evidenceIds.length) return false;
    return record.evidenceIds.every(id => {
        const source = store.source(record.userId, record.scope, id);
        return source?.state === 'learned' && (source.speaker ?? source.userId) === record.subject &&
            groundedReplyPreferences(source).some(support => support.dimension === claim.dimension && support.value === claim.value && support.polarity === claim.polarity);
    });
}
// Evaluate all active claims, before ranking, topK or the three-source floor.
// Even one authorized opposite observation withholds the entire dimension.
export function groundedStyleCandidates(items, store) {
    const claims = items.filter(({record}) => record.kind === 'trait' && supported(record, store));
    const conflicting = new Set();
    for (const {record} of claims) for (const {record: other} of claims) {
        if (record.userId === other.userId && record.scope === other.scope && record.subject === other.subject &&
            record.replyPreference.dimension === other.replyPreference.dimension && (record.replyPreference.value !== other.replyPreference.value || record.replyPreference.polarity === 'denied' || other.replyPreference.polarity === 'denied'))
            conflicting.add(record.replyPreference.dimension);
    }
    const allowed = new Set(claims.filter(({record}) => record.replyPreference.polarity === 'affirmed' && !conflicting.has(record.replyPreference.dimension) && new Set(record.evidenceIds).size >= 3).map(({record}) => record.id));
    return items.filter(({record}) => record.kind !== 'trait' || allowed.has(record.id));
}
