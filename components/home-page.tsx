/* oxlint-disable jsx-a11y/media-has-caption -- The film is a supplied cut; its caption sits beside the player. */
import Image from 'next/image';
import { ArrowUpRight, Play } from 'lucide-react';
import { sitePath } from '../lib/site-path';
import { Header, Footer, repo } from './site-header';
import { InstallCommand } from './install-command';
import { HeroDevices } from './hero-devices';
import { Gallery } from './gallery';
import '../app/home.css';

const rel = `${repo}/releases/download/v1.0.0/nova-personal-agent-1.0.0`;

export function HomePage({ en = false }: { en?: boolean }) {
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const film = sitePath('/media/film/nova-launch-720p');
  const arch = (theme: string) =>
    sitePath(`/doc-assets/assets/architecture/nova-overview.${en ? 'en' : 'zh-CN'}.${theme}.svg`);

  const points = en
    ? [
        ['Speaks up', 'When something deserves your attention, like an invite that clashes with another plan, Nova tells you and drafts a reply. It never sends without you.'],
        ['Remembers', 'Your timeline and profile fill in as you talk. Every answer says where it came from, and you can edit or delete any memory.'],
        ['Works while you chat', 'Hand over a task and keep talking. One part of Nova stays in the conversation while another does the work in the background.'],
        ['Talk to it like a person', 'Interrupt, correct, or add to a request halfway through. Voice and text both work.'],
        ['Stays with you', 'Your Space lives on your own computer. Your phone and other computers sync with it through an end-to-end encrypted relay or Tailscale.'],
      ]
    : [
        ['主动开口', '有事值得你看，比如一个和别的安排撞期的邀请，Nova 会告诉你，并起草一封回复。发不发，由你决定。'],
        ['记得住', '聊得越多，时间线和个人资料越完整。每个回答都标明出处，任何一条记忆你都能改、能删。'],
        ['边做边聊', '交代完任务，接着聊别的。Nova 一部分留在对话里陪你，另一部分在后台干活。'],
        ['像跟人说话', '做到一半可以打断、纠正、补充要求。语音和文字都行。'],
        ['数据在你手里', 'Space 放在你自己的电脑上。手机和其他电脑通过端到端加密的 relay 或 Tailscale 与它同步。'],
      ];

  const downloads: [string, [string, string][]][] = [
    ['macOS · Apple Silicon', [['DMG', `${rel}-macos-arm64.dmg`], ['ZIP', `${rel}-macos-arm64-app.zip`]]],
    ['Windows · x64', [['EXE', `${rel}-windows-x64.exe`], [en ? 'Portable ZIP' : '便携版 ZIP', `${rel}-windows-x64-portable.zip`]]],
    ['Linux · Ubuntu 22.04+', [['AppImage', `${rel}-linux-x64.AppImage`], ['DEB', `${rel}-linux-x64.deb`]]],
  ];

  return (
    <>
      <Header en={en} />
      <main id="main">
        <section className="hero wrap" id="overview">
          <div className="hero-copy">
            <h1>{en ? 'Keep talking. Nova keeps working.' : '你接着聊，它接着干。'}</h1>
            <p>
              {en
                ? 'Tell Nova what you need, by voice or text, on your computer or your phone. It gets on with it while you carry on: building a site, reading a paper, finding a video. Anything that goes out under your name stays a draft until you send it.'
                : '用说的或者打字都行，电脑和手机上都能用。你交代一件事，它就去做，你接着聊别的：做个网站、读篇论文、找个视频。要以你的名义发出去的东西，只存成草稿，由你来发。'}
            </p>
            <div className="actions">
              <a className="btn btn-primary" href="#get">
                {en ? 'Download v1.0.0' : '下载 v1.0.0'}
              </a>
              <a className="btn" href="#film">
                <Play size={14} aria-hidden="true" /> {en ? 'Watch the film' : '看宣传片'}
              </a>
              <a className="btn" href={repo} target="_blank" rel="noreferrer">
                GitHub <ArrowUpRight size={14} aria-hidden="true" />
              </a>
            </div>
          </div>
          <HeroDevices en={en} />
        </section>

        <section className="film wrap" id="film" aria-labelledby="film-title">
          <h2 id="film-title">{en ? 'Two minutes with Nova' : '两分钟看完 Nova'}</h2>
          <figure>
            <video
              controls
              playsInline
              preload="none"
              poster={`${film}.webp`}
              width={1280}
              height={720}
              aria-label={en ? 'Nova product film, 720p preview' : 'Nova 宣传片，720p 预览版'}
            >
              <source src={`${film}.mp4`} type="video/mp4" />
            </video>
            <figcaption>
              {en
                ? 'A scenario film. The characters are fictional; the screen recordings are real.'
                : '场景演绎，人物是虚构的，屏幕录制是真实的。'}
            </figcaption>
          </figure>
        </section>

        <section className="how wrap" id="demo">
          <div className="how-copy">
            <h2>{en ? 'One Space, every device' : '一个 Space，所有设备'}</h2>
            <p>
              {en
                ? 'Your Space lives on a computer you control. Your phone and other computers join it over an encrypted link. Nova works from the sources you allow and hands back results with their sources attached.'
                : 'Space 放在你自己掌握的电脑上。手机和其他电脑通过加密连接加入进来。Nova 只读你授权的资料，交回的结果都附着出处。'}
            </p>
            <a className="link" href={`${doc}/architecture/`}>
              {en ? 'How it works' : '了解架构'} <ArrowUpRight size={14} aria-hidden="true" />
            </a>
          </div>
          <figure className="how-figure">
            <Image
              unoptimized
              className="only-light"
              src={arch('light')}
              alt={en ? 'Nova architecture: devices, Space, conversation, task coordination and executors' : 'Nova 架构：设备、Space、对话、任务协调与执行器'}
              width={1586}
              height={992}
            />
            <Image unoptimized className="only-dark" src={arch('dark')} alt="" aria-hidden="true" width={1586} height={992} />
          </figure>
        </section>

        <section className="points wrap" id="whats-new" aria-labelledby="points-title">
          <h2 id="points-title">{en ? 'What is in 1.0' : '1.0 有什么'}</h2>
          <dl>
            {points.map(([term, body]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <Gallery en={en} />

        <section className="get wrap" id="get">
          <h2>{en ? 'Get Nova' : '下载 Nova'}</h2>
          <table>
            <caption className="sr-only">{en ? 'Desktop downloads for v1.0.0' : 'v1.0.0 桌面端下载'}</caption>
            <tbody>
              {downloads.map(([os, links]) => (
                <tr key={os}>
                  <th scope="row">{os}</th>
                  <td>
                    {links.map(([label, href]) => (
                      <a key={label} href={href}>{label}</a>
                    ))}
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row">iOS · Android</th>
                <td className="soon">
                  {/* TODO(v1.0.0): add the TestFlight invitation and Android APK links before release. */}
                  {en ? 'TestFlight and APK links arrive with the release.' : 'TestFlight 和 APK 链接会随正式发布补上。'}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="get-npm">{en ? 'Or install with npm:' : '也可以用 npm 安装：'}</p>
          <InstallCommand en={en} />
          <p className="small">
            {en
              ? 'Needs Node.js 22.13+ and npm. For coding tasks, install and sign in to the coding agent you want to use.'
              : '需要 Node.js 22.13+ 和 npm。要做编码任务，先安装并登录你选的编码代理。'}
          </p>
          <div className="get-links">
            <a className="link" href={doc}>{en ? 'Documentation' : '使用文档'} <ArrowUpRight size={14} aria-hidden="true" /></a>
            <a className="link" href={`${repo}/releases/tag/v1.0.0`}>{en ? 'Release notes' : '发布说明'} <ArrowUpRight size={14} aria-hidden="true" /></a>
            <a className="link" href={repo} target="_blank" rel="noreferrer">{en ? 'Source on GitHub' : '源码'} <ArrowUpRight size={14} aria-hidden="true" /></a>
          </div>
        </section>
      </main>
      <Footer en={en} />
    </>
  );
}
