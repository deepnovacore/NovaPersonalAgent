'use client';
import { useSyncExternalStore } from 'react';
import { Download } from 'lucide-react';
import {
  apk,
  desktopOS,
  platforms,
  testflight,
  type Desk,
} from '../lib/downloads';
import { InstallCommand } from './install-command';
import {
  AndroidIcon,
  AppleIcon,
  LinuxIcon,
  WindowsIcon,
} from './platform-icons';

const ICON = { mac: AppleIcon, win: WindowsIcon, linux: LinuxIcon };
const noop = () => () => {};

// One button for the visitor's desktop system, the other systems beside it,
// the phone apps, and the npm command below.
export function HeroDownload({ en = false }: { en?: boolean }) {
  const os = useSyncExternalStore(noop, desktopOS, () => 'mac' as Desk);
  const all = platforms(en);
  const desk = (['mac', 'win', 'linux'] as Desk[]).map((id) =>
    all.find((p) => p.id === id)!,
  );
  const main = desk.find((p) => p.id === os)!;
  const MainIcon = ICON[os];

  return (
    <div className="hd">
      <div className="hd-row">
        <a
          className="hd-main"
          href={main.links[0][1]}
          aria-label={en ? `Download for ${main.name}` : `下载 ${main.name} 版`}
        >
          <MainIcon size={20} />
          {main.name}
          <Download size={18} aria-hidden="true" />
        </a>
        <ul
          className="hd-more"
          aria-label={en ? 'Other platforms' : '其他平台'}
        >
          {desk
            .filter((p) => p.id !== os)
            .map((p) => {
              const Icon = ICON[p.id as Desk];
              return (
                <li key={p.id}>
                  <a href={p.links[0][1]}>
                    <Icon size={16} />
                    {p.name}
                  </a>
                </li>
              );
            })}
          <li>
            <a href={testflight} target="_blank" rel="noreferrer">
              <AppleIcon size={16} />
              iOS
            </a>
          </li>
          <li>
            <a href={apk}>
              <AndroidIcon size={16} />
              Android
            </a>
          </li>
        </ul>
      </div>
      <InstallCommand en={en} />
    </div>
  );
}
