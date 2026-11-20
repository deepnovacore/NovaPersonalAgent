import { sitePath } from '../lib/site-path';
import { ArrowUpRight, Download } from 'lucide-react';
import { DocsSearch } from './docs-search';
import { LanguageSwitch } from './language-switch';
import { ThemeToggle } from './theme-toggle';
import { EclipseMark } from './eclipse-mark';
// The company mark beside the app's eclipse.
function NovaMark() {
  return (
    <span className="nova-mark" aria-hidden="true">
      {/* oxlint-disable-next-line next/no-img-element -- a small fixed mark on a static export */}
      <img
        className="mark-company"
        src={sitePath('/brand/deepnovacore-mark-hd.png')}
        alt=""
        width={480}
        height={232}
      />
      <EclipseMark className="mark-eclipse" />
    </span>
  );
}
export const repo = 'https://github.com/deepnovacore/NovaPersonalAgent';
export function Header({
  en = false,
  docs = false,
  alternate,
  section,
}: {
  en?: boolean;
  docs?: boolean;
  alternate?: string;
  section?: 'users' | 'developers';
}) {
  const home = sitePath(en ? '/' : '/zh');
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const developers = doc + '/archs/00-overview';
  return (
    <>
      <a className="skip" href="#main">
        {en ? 'Skip to content' : '跳转到正文'}
      </a>
      <header className="header">
        <div className="header-leading">
          <a href={home} className="brand" aria-label="Nova Personal Agent">
            <span className="brand-name">
              <span className="brand-full">Nova Personal Agent</span>
              <span className="brand-short">NPA</span>
            </span>
          </a>
          {docs && <DocsSearch en={en} />}
        </div>
        <nav aria-label={en ? 'Main navigation' : '主导航'}>
          <a
            className="audience-tab"
            href={doc}
            aria-current={section === 'users' ? 'page' : undefined}
          >
            {en ? 'Users' : '用户指南'}
          </a>
          <a
            className="audience-tab"
            href={developers}
            aria-current={section === 'developers' ? 'page' : undefined}
          >
            {en ? 'Developers' : '开发文档'}
          </a>
          <a
            className="nav-github"
            href={repo}
            target="_blank"
            rel="noreferrer"
          >
            GitHub <ArrowUpRight size={12} />
          </a>
          <a className="nav-download" href={`${home}#get`}>
            <Download size={14} aria-hidden="true" />
            {en ? 'Download' : '下载'}
          </a>
          <div className="header-controls">
            <ThemeToggle en={en} />
            <LanguageSwitch en={en} docs={docs} alternate={alternate} />
          </div>
        </nav>
      </header>
    </>
  );
}
export function Footer({ en = false }: { en?: boolean }) {
  return (
    <footer className="footer wrap">
      <a className="brand" href={sitePath(en ? '/' : '/zh')}>
        <NovaMark />
        Nova Personal Agent
      </a>
      <span>© 2026 {en ? 'DeepNovaCore' : '深穹星核'}</span>
      <a href={repo + '/blob/main/LICENSE'}>GPL-3.0-or-later</a>
    </footer>
  );
}
