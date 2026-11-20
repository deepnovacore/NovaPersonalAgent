'use client';
import { useSyncExternalStore } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { desktopOS, platforms, type Desk } from '../lib/downloads';
import { InstallCommand } from './install-command';
import {
  AndroidIcon,
  AppleIcon,
  LinuxIcon,
  WindowsIcon,
} from './platform-icons';

const noop = () => () => {};

// One card per platform; the visitor's desktop system is highlighted.
export function DownloadCards({ en = false }: { en?: boolean }) {
  const os = useSyncExternalStore(noop, desktopOS, () => 'mac' as Desk);
  return (
    <>
      <ul className="dl-cards">
        {platforms(en).map((p) => (
          <li
            key={p.id}
            className="dl-card"
            data-current={p.id === os || undefined}
          >
            <span className="dl-icon" aria-hidden="true">
              {p.id === 'mac' && <AppleIcon size={26} />}
              {p.id === 'win' && <WindowsIcon size={24} />}
              {p.id === 'linux' && <LinuxIcon size={26} />}
              {p.id === 'mobile' && (
                <>
                  <AppleIcon size={22} />
                  <AndroidIcon size={22} />
                </>
              )}
            </span>
            <h3>{p.name}</h3>
            {p.note && <p>{p.note}</p>}
            <div className="dl-links">
              {p.links.map(([label, href], i) => {
                const external = href.startsWith('https://testflight');
                return (
                  <a
                    key={href}
                    className={i === 0 ? 'dl-btn dl-btn-primary' : 'dl-btn'}
                    href={href}
                    {...(external
                      ? { target: '_blank', rel: 'noreferrer' }
                      : {})}
                  >
                    {external ? (
                      <ExternalLink size={15} aria-hidden="true" />
                    ) : (
                      <Download size={15} aria-hidden="true" />
                    )}
                    {label}
                  </a>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      <div className="dl-npm">
        <InstallCommand en={en} />
        <p>
          {en
            ? 'Or install with npm. Requires Node.js 22.13+.'
            : '或用 npm 安装，需要 Node.js 22.13+。'}
        </p>
      </div>
    </>
  );
}
