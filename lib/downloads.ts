import { repo } from '../components/site-header';

export type Platform = {
  id: 'mac' | 'win' | 'linux' | 'mobile';
  name: string;
  links: [string, string][];
  note?: string;
};
export type Desk = 'mac' | 'win' | 'linux';

export const version = '1.0.0';
const rel = `${repo}/releases/download/v${version}/nova-personal-agent-${version}`;
export const testflight = 'https://testflight.apple.com/join/eQrtvXYJ';
export const apk = `${rel}-android-arm64.apk`;

// The visitor's desktop system, macOS on the server and as a fallback.
export function desktopOS(): Desk {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return 'win';
  if (/Linux/.test(ua) && !/Android/.test(ua)) return 'linux';
  return 'mac';
}

// Same files as the README's download table.
export function platforms(en: boolean): Platform[] {
  return [
    {
      id: 'mac',
      name: 'macOS',
      links: [
        ['DMG', `${rel}-macos-arm64.dmg`],
        ['ZIP', `${rel}-macos-arm64-app.zip`],
      ],
      note: en ? 'Apple Silicon (arm64)' : '适用于 Apple 芯片（arm64）',
    },
    {
      id: 'win',
      name: 'Windows',
      links: [
        [en ? 'Installer' : '安装包', `${rel}-windows-x64.exe`],
        [en ? 'Portable ZIP' : '便携版 ZIP', `${rel}-windows-x64-portable.zip`],
      ],
      note: 'x64',
    },
    {
      id: 'linux',
      name: 'Linux',
      links: [
        ['AppImage', `${rel}-linux-x64.AppImage`],
        ['DEB', `${rel}-linux-x64.deb`],
      ],
      note: en ? 'Ubuntu 22.04 or later, x64' : 'Ubuntu 22.04 及以上，x64',
    },
    {
      id: 'mobile',
      name: 'iOS / Android',
      links: [
        ['iOS TestFlight', testflight],
        ['Android APK', apk],
      ],
      note: en ? 'The phone app is called NovaCore' : '手机端应用名为 NovaCore',
    },
  ];
}
