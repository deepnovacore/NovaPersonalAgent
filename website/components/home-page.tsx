/* oxlint-disable jsx-a11y/media-has-caption -- The film is a supplied cut; its caption sits beside the player. */
import Image from 'next/image';
import { sitePath } from '../lib/site-path';
import { Header, Footer, repo } from './site-header';
import { InstallCommand } from './install-command';
import { NovaMark } from './nova-mark';
import { Scenes } from './scenes';
import '../app/home.css';

const rel = `${repo}/releases/download/v1.0.0/nova-personal-agent-1.0.0`;

export function HomePage({ en = false }: { en?: boolean }) {
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const film = sitePath('/media/film/nova-launch-720p');
  const arch = (theme: string) =>
    sitePath(
      `/doc-assets/assets/architecture/nova-overview.${en ? 'en' : 'zh-CN'}.${theme}.svg`,
    );

  const release = en
    ? [
        'Your data lives on your own computer',
        'One app for iOS and Android',
        'A rebuilt desktop workbench',
        'Coding, computer and phone under one set of approvals',
        'Memory with sources, and deletion that really deletes',
      ]
    : [
        '数据放在自己的电脑上',
        'iOS、Android 同一个 App',
        '重做的桌面工作台',
        '编码、电脑、手机，同一套审批',
        '记忆带出处，删了就是真删',
      ];

  const downloads: [string, [string, string][]][] = [
    [
      en ? 'macOS (Apple Silicon)' : 'macOS（Apple 芯片）',
      [
        ['DMG', `${rel}-macos-arm64.dmg`],
        ['ZIP', `${rel}-macos-arm64-app.zip`],
      ],
    ],
    [
      en ? 'Windows (x64)' : 'Windows（x64）',
      [
        [en ? 'Installer' : '安装包', `${rel}-windows-x64.exe`],
        [en ? 'Portable' : '免安装版', `${rel}-windows-x64-portable.zip`],
      ],
    ],
    [
      en ? 'Linux (Ubuntu 22.04 or later)' : 'Linux（Ubuntu 22.04 及以上）',
      [
        ['AppImage', `${rel}-linux-x64.AppImage`],
        ['DEB', `${rel}-linux-x64.deb`],
      ],
    ],
  ];

  return (
    <>
      <Header en={en} />
      <main id="main">
        <section
          className="hero wrap"
          id="overview"
          aria-labelledby="hero-title"
        >
          <div className="hero-head">
            <NovaMark size={64} animate label="Nova" />
            <div>
              <h1 id="hero-title">Nova Personal Agent</h1>
              <p>
                {en
                  ? 'An open-source personal agent for your computer and phone.'
                  : '开源的个人 Agent，装在你的电脑和手机上。'}
              </p>
            </div>
          </div>
          <div className="actions">
            <a className="btn btn-primary" href="#get">
              {en ? 'Download v1.0.0' : '下载 v1.0.0'}
            </a>
            <a className="btn" href={repo} target="_blank" rel="noreferrer">
              {en ? 'View on GitHub' : '在 GitHub 查看'}
            </a>
          </div>
          <figure className="hero-film" id="film">
            <video
              controls
              playsInline
              preload="none"
              poster={`${film}.webp`}
              width={1280}
              height={720}
              aria-label={en ? 'Nova launch film, 720p' : 'Nova 宣传片，720p'}
            >
              <source src={`${film}.mp4`} type="video/mp4" />
            </video>
            <figcaption>
              {en
                ? 'Launch film, about two minutes, in Chinese.'
                : '宣传片，约两分钟。'}
            </figcaption>
          </figure>
        </section>

        <Scenes en={en} />

        <section
          className="release wrap"
          id="whats-new"
          aria-labelledby="release-title"
        >
          <h2 id="release-title">{en ? 'New in 1.0' : '1.0 有什么'}</h2>
          <ul>
            {release.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <figure className="arch" id="demo">
            <Image
              unoptimized
              className="only-light"
              src={arch('light')}
              alt={
                en
                  ? 'How Nova fits together: your devices, your Space, the conversation and the executors'
                  : 'Nova 的结构：你的设备、你的 Space、对话和执行器'
              }
              width={1586}
              height={992}
            />
            <Image
              unoptimized
              className="only-dark"
              src={arch('dark')}
              alt=""
              aria-hidden="true"
              width={1586}
              height={992}
            />
          </figure>
          <p className="release-links">
            <a className="link" href={`${repo}/releases/tag/v1.0.0`}>
              {en ? 'Full release notes' : '完整发布说明'}
            </a>
            <a className="link" href={`${doc}/architecture/`}>
              {en ? 'Architecture' : '架构说明'}
            </a>
          </p>
        </section>

        <section className="get wrap" id="get" aria-labelledby="get-title">
          <h2 id="get-title">{en ? 'Download Nova' : '下载 Nova'}</h2>
          <table>
            <caption className="sr-only">
              {en ? 'Desktop downloads for v1.0.0' : 'v1.0.0 桌面端下载'}
            </caption>
            <tbody>
              {downloads.map(([os, links]) => (
                <tr key={os}>
                  <th scope="row">{os}</th>
                  <td>
                    {links.map(([label, href]) => (
                      <a key={label} href={href}>
                        {label}
                      </a>
                    ))}
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row">iOS / Android</th>
                <td className="soon">
                  {/* TODO(v1.0.0): add the TestFlight invitation and Android APK links before release. */}
                  {en
                    ? 'Links go up with the release.'
                    : '链接随正式发布补上。'}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="get-npm">
            {en ? 'Or install with npm:' : '也可以用 npm 安装：'}
          </p>
          <InstallCommand en={en} />
          <p className="small">
            {en
              ? 'Requires Node.js 22.13 or later. For coding tasks, install and sign in to the coding agent you want to use.'
              : '需要 Node.js 22.13 或更高版本。要做编码任务，先安装并登录你要用的编码代理。'}
          </p>
          <p className="get-links">
            <a className="link" href={doc}>
              {en ? 'Documentation' : '使用文档'}
            </a>
            <a className="link" href={`${repo}/releases/tag/v1.0.0`}>
              {en ? 'Release notes' : '发布说明'}
            </a>
            <a className="link" href={repo} target="_blank" rel="noreferrer">
              {en ? 'Source code' : '源代码'}
            </a>
          </p>
        </section>
      </main>
      <Footer en={en} />
    </>
  );
}
