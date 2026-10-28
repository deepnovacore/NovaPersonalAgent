import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@radix-ui/themes';
import { t } from '../../locale.mjs';
export type AnyRecord = Record<string, any>;
export function Action({ children, action, disabled = false, ...props }: any) {
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    const lock = useRef(false);
    return <><Button type="button" {...props} disabled={disabled || busy} aria-busy={busy} onClick={async () => { if (lock.current)
        return; lock.current = true; setBusy(true); setError(''); try {
        await action();
    }
    catch (e: any) {
        setError(e?.message || t('操作未完成'));
    }
    finally {
        lock.current = false;
        setBusy(false);
    } }}>{children}</Button>{error && <p role="alert">{error}</p>}</>;
}
export function Field({ label, value, onChange, type = 'text', options, ...props }: any) {
    const inputProps = { ...props, 'aria-label': label, onChange: (e: any) => onChange(type === 'checkbox' ? e.target.checked : type === 'number' || type === 'range' ? Number(e.target.value) : e.target.value) };
    return <label className={type === 'checkbox' ? 'toggle-row' : 'field'}><span>{t(label)}</span>{options ? <select {...inputProps} value={value ?? ''}>{options.map((o: any) => { const v = typeof o === 'string' ? o : o.value; return <option key={v} value={v}>{t(typeof o === 'string' ? o : o.label)}</option>; })}</select> : type === 'textarea' ? <textarea {...inputProps} value={value ?? ''}/> : type === 'checkbox' ? <input {...inputProps} type="checkbox" role="switch" checked={value === true}/> : <input {...inputProps} type={type} value={value ?? ''}/>}</label>;
}
export function Card({ title, children, description }: any) { return <article className="im-card"><h3>{t(title)}</h3>{description && <p>{t(description)}</p>}{children}</article>; }
export function useCommand(api: any, method = 'personalCommand', initial = 'state') {
    const [state, setState] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const active = useRef(true), lock = useRef(false), epoch = useRef(0);
    useEffect(() => { active.current = true; return () => { active.current = false; epoch.current++; }; }, []);
    const command = useCallback(async (name = initial, params: any = {}) => { if (lock.current)
        throw Error(t('请等待当前操作完成')); if (!api?.[method])
        return; lock.current = true; setBusy(true); setError(''); const run = epoch.current; try {
        const result = await api[method](name, params);
        if (result?.error)
            throw Error(result.error);
        const next = name === initial ? result : await api[method](initial, {});
        if (next?.error)
            throw Error(next.error);
        if (active.current && run === epoch.current)
            setState(next);
        return result;
    }
    catch (e: any) {
        if (active.current)
            setError(e.message || t('连接暂时不可用'));
        throw e;
    }
    finally {
        lock.current = false;
        if (active.current)
            setBusy(false);
    } }, [api, method, initial]);
    useEffect(() => { void command().catch(() => { }); }, [command]);
    return { state, busy, error, command, setState };
}
