'use client';
import { useEffect, useRef } from 'react';
export function DocBody({ html }: { html: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    const nodes = root.current?.querySelectorAll<HTMLElement>('.mermaid');
    if (nodes?.length) import('mermaid').then(async ({ default: mermaid }) => {
      if (cancelled) return;
      mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'strict', themeVariables: { primaryColor: '#15263b', primaryTextColor: '#dce8f7', primaryBorderColor: '#4c698f', lineColor: '#7397c4', secondaryColor: '#1b3047', tertiaryColor: '#101c2b', fontFamily: 'system-ui, sans-serif', fontSize: '15px' } });
      await mermaid.run({ nodes: Array.from(nodes) });
    }).catch(console.error);
    return () => { cancelled = true; };
  }, [html]);
  return <div ref={root} className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}
