/* oxlint-disable jsx-a11y/media-has-caption -- The film is a supplied cut; its caption sits beside the player. */
import Image from 'next/image';
import { sitePath } from '../lib/site-path';
import { heroClip, heroLines } from '../lib/scenes';
import { Header, Footer, repo } from './site-header';
import { InstallCommand } from './install-command';
import { NovaMark } from './nova-mark';
import { ClipPlayer, Exchange } from './exchange';
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
        'Space, Host and Client. Your data lives on a computer you control; phones and other computers connect to it over an end-to-end encrypted relay or Tailscale.',
        'One app for iOS and Android, with the timeline, profile and documents. Pair it with your computer or run it on its own.',
        'A rebuilt desktop workbench: timeline, ideas, goals, feeds, tasks and profile next to the conversation.',
        'More ways to act: coding agents, computer use, supervised phone use and camera watching, all under the same approvals.',
        'Memory you can check: a local record with sources, separate consent for reading and for model processing, and real deletion.',
      ]
    : [
        'Space、Host 和 Client。数据放在你自己掌握的电脑上，手机和其他电脑通过端到端加密的 relay 或 Tailscale 连进来。',
        'iOS 和 Android 用同一个 App，带时间线、个人资料和文档。可以连你的电脑，也可以单独用。',
        '重做的桌面工作台：时间线、想法、目标、资讯、任务和个人资料，都在对话旁边。',
        '能动手的地方更多了：编码代理、操作电脑、受监督地操作手机、看摄像头，都走同一套审批。',
        '记忆可以核对：本地记录带出处，读取资料和交给模型处理分开授权，删除就是真删除。',
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
          <div className="hero-words">
            <div className="hero-mark">
              <NovaMark size={56} animate label="Nova" />
            </div>
            <h1 id="hero-title" className="sr-only">
              {en ? 'Nova Personal Agent' : 'Nova 个人 Agent'}
            </h1>
            <Exchange lines={heroLines} en={en} />
          </div>
          <ClipPlayer clip={heroClip} en={en} />
          <div className="hero-foot">
            <p>
              {en
                ? 'Nova is an open-source personal agent for your computer and your phone. Tell it what you need, by voice or by typing.'
                : 'Nova 是一个开源的个人 Agent，装在电脑和手机上，用说话或打字交代事情。'}
            </p>
            <div className="actions">
              <a className="btn btn-primary" href="#get">
                {en ? 'Download v1.0.0' : '下载 v1.0.0'}
              </a>
              <a className="btn" href={repo} target="_blank" rel="noreferrer">
                {en ? 'View on GitHub' : '在 GitHub 查看'}
              </a>
            </div>
          </div>
        </section>

        <Scenes en={en} />

        <section className="film wrap" id="film" aria-labelledby="film-title">
          <h2 id="film-title">{en ? 'The launch film' : '宣传片'}</h2>
          <figure>
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
                ? 'Two minutes, in Chinese. The people are fictional; the screen recordings are real.'
                : '时长约两分钟。人物是虚构的，屏幕录制是真实的。'}
            </figcaption>
          </figure>
        </section>

        <section
          className="release wrap"
          id="whats-new"
          aria-labelledby="release-title"
        >
          <h2 id="release-title">
            {en ? 'In version 1.0' : '1.0 版本里有什么'}
          </h2>
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
          <a className="link" href={`${doc}/architecture/`}>
            {en ? 'Read the architecture notes' : '阅读架构说明'}
          </a>
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
