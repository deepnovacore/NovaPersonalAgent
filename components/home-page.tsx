import {
  AudioLines,
  BookMarked,
  HardDrive,
  MessagesSquare,
  Sparkles,
} from 'lucide-react';
import { sitePath } from '../lib/site-path';
import { Header, Footer, repo } from './site-header';
import { HeroDownload } from './hero-download';
import { FilmEmbed } from './film-embed';
import { DownloadCards } from './download-cards';
import { GalleryGrid } from './gallery-grid';
import { Features } from './features';
import { Diagram } from './diagram';
import { BackToTop } from './back-to-top';
import { EclipseMark } from './eclipse-mark';
import '../app/home.css';

// Copy on this page comes from the v4 launch film (nova-v1-launch-work/films/
// product-v4/src/locales), the README and the docs, not new marketing lines.
export function HomePage({ en = false }: { en?: boolean }) {
  const doc = sitePath(en ? '/en/docs' : '/docs');
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
  // Architecture highlights, word for word from the README.
  const pillars: [typeof Sparkles, string, string][] = en
    ? [
        [
          Sparkles,
          'Proactive',
          'Nova chooses what matters and when to speak, and drafts instead of sending.',
        ],
        [
          BookMarked,
          'Memory',
          'A source-backed Timeline and Profile grow as you talk; every memory can be traced, edited or forgotten.',
        ],
        [
          MessagesSquare,
          'Interactive',
          'Keep talking while work runs in the background.',
        ],
        [
          AudioLines,
          'Voice-first',
          'Full-duplex voice: a front brain that talks and a back brain that works.',
        ],
        [
          HardDrive,
          'Local-first',
          'Your Space lives on a Host you control; devices sync through an end-to-end encrypted relay or Tailscale.',
        ],
      ]
    : [
        [Sparkles, '主动', 'Nova 判断什么值得说、何时开口，只起草，不替你发。'],
        [
          BookMarked,
          '记忆',
          '有出处的 Timeline 与画像随对话生长，每条记忆都可追溯、编辑或遗忘。',
        ],
        [MessagesSquare, '可交互', '后台干活，前台照常聊。'],
        [AudioLines, '语音优先', '全双工语音：前脑负责说，后脑负责做。'],
        [
          HardDrive,
          '本地优先',
          'Space 住在你掌控的 Host 上，设备通过端到端加密的 relay 或 Tailscale 同步。',
        ],
      ];

  return (
    <>
      <Header en={en} />
      <main id="main">
        {/* Follows the site theme, with soft brand light drifting behind the title. */}
        <section className="hero" id="overview" aria-labelledby="hero-title">
          <div className="aurora" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="hero-head wrap">
            <div className="hero-lockup">
              {/* oxlint-disable next/no-img-element -- fixed logos on a static export */}
              <img
                className="lockup-company on-light"
                src={sitePath(
                  `/brand/deepnovacore-logo-${en ? 'en' : 'zh'}-on-light.png`,
                )}
                alt="DeepNovaCore"
                width={640}
                height={en ? 349 : 404}
              />
              <img
                className="lockup-company on-dark"
                src={sitePath(
                  `/brand/deepnovacore-logo-${en ? 'en' : 'zh'}-on-dark.png`,
                )}
                alt="DeepNovaCore"
                width={640}
                height={en ? 349 : 404}
              />
              {/* oxlint-enable next/no-img-element */}
              <i aria-hidden="true" />
              <EclipseMark className="mark-eclipse" />
            </div>
            <h1 id="hero-title">
              <span className="t-nova">Nova</span> Personal Agent
            </h1>
            <span className="hero-rule" aria-hidden="true" />
            <p className="hero-sub">
              {en
                ? 'Gets to know you as you talk. Your assistant, your partner.'
                : '在交互中懂你，你的助手，你的伙伴。'}
            </p>
            <p className="hero-lede">
              {en
                ? 'The first personal assistant you can talk to in real time. It chats while it works, learns you as you talk, and runs entirely on your devices: no cloud computer, all data local.'
                : '第一个能实时语音交互的个人助理，边聊天边干活，越聊越懂你，纯端侧运行，无需云电脑，数据全在本地'}
            </p>
            <HeroDownload en={en} />
          </div>
          <div className="hero-film wrap">
            <FilmEmbed en={en} />
          </div>
        </section>

        <Features en={en} />

        <section className="get wrap" id="get" aria-labelledby="get-title">
          <h2 id="get-title">{en ? 'Get Nova' : '下载 Nova'}</h2>
          <p className="section-lede">
            {en
              ? 'Desktop, phone, or npm. Free and open source.'
              : '桌面端、手机端，或者用 npm 安装，免费开源。'}
          </p>
          <DownloadCards en={en} />
          <p className="get-links">
            <a className="link" href={`${repo}/releases/tag/v1.0.0`}>
              {en ? 'Release notes and checksums' : '发布说明与校验'}
            </a>
            <a className="link" href={doc}>
              {en ? 'Getting started' : '快速开始'}
            </a>
            <a className="link" href={repo} target="_blank" rel="noreferrer">
              {en ? 'Source code' : '源代码'}
            </a>
          </p>
        </section>

        <GalleryGrid en={en} />

        <section className="arch wrap" id="how" aria-labelledby="arch-title">
          <div className="arch-text">
            <h2 id="arch-title">{en ? 'Architecture' : '技术架构'}</h2>
            <p className="section-lede">
              {en
                ? 'Your context informs the conversation; the front brain coordinates work with the back brain. Nova checks results and speaks when it matters.'
                : '你的上下文帮助 Nova 理解需求，前脑通过对话协调后脑执行。结果按证据核对，提醒在合适时机开口。'}
            </p>
            <ul className="arch-points">
              {pillars.map(([Icon, name, body]) => (
                <li key={name}>
                  <span className="arch-icon" aria-hidden="true">
                    <Icon size={18} />
                  </span>
                  <div>
                    <b>{name}</b>
                    <p>{body}</p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="get-links">
              <a className="link" href={`${doc}/architecture/`}>
                {en ? 'Architecture docs' : '架构文档'}
              </a>
            </p>
          </div>
          <Diagram
            name="nova-overview"
            en={en}
            width={1586}
            height={992}
            alt={
              en
                ? 'How Nova fits together: your devices, your Space, the conversation and the executors'
                : 'Nova 的结构：你的设备、你的 Space、对话和执行器'
            }
          />
        </section>

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
          <p className="get-links">
            <a className="link" href={`${repo}/releases/tag/v1.0.0`}>
              {en ? 'Full release notes' : '完整发布说明'}
            </a>
          </p>
        </section>
      </main>
      <BackToTop en={en} />
      <Footer en={en} />
    </>
  );
}
