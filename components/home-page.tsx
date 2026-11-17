/* oxlint-disable jsx-a11y/media-has-caption -- Keep the supplied original demo without added subtitles. */
import Image from 'next/image';
import { featureCards } from '../lib/home-features';
import { sitePath } from '../lib/site-path';
import { ArrowRight, ArrowUpRight, Play } from 'lucide-react';
import { Header, Footer, repo } from './site-header';
import { InstallCommand } from './install-command';
import { Gallery } from './gallery';
import { NovaOrb } from './nova-orb';
export function HomePage({ en = false }: { en?: boolean }) {
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const film = sitePath('/media/film/nova-launch-720p');
  const arch = (theme: string) => sitePath(`/doc-assets/assets/architecture/nova-overview.${en ? 'en' : 'zh-CN'}.${theme}.svg`);
  const highlights = en ? [
    ['Space / Host / Client', 'Your Space lives on a host you control. Desktop, iOS and Android join it over an end-to-end encrypted relay or Tailscale.'],
    ['One companion on every screen', 'A unified iOS and Android app with the Timeline, Profile and documents, paired to your Space or running standalone.'],
    ['A rebuilt Workbench', 'Timeline, Ideas, Goals, Feeds, Tasks and Profile beside Chat, Plan, Build and Delegate conversations.'],
    ['More hands for the work', 'Coding agents, computer use, supervised mobile use and loop-camera monitoring share approvals, cancellation and evidence checks.'],
    ['Memory you can audit', 'A local ledger with optional mem0 or voicemem recall, separate consent for reading and for model processing, and real forget controls.'],
  ] : [
    ['Space / Host / Client', 'Space 住在你掌控的主机上；桌面、iOS 与 Android 通过端到端加密的 relay 或 Tailscale 加入。'],
    ['每块屏幕上同一个伙伴', '统一的 iOS / Android 应用，带 Timeline、画像与文档，可配对 Space，也可独立运行。'],
    ['重做的 Workbench', 'Timeline、想法、目标、信息流、任务与画像，配合 Chat、Plan、Build、Delegate 多种会话。'],
    ['更多双手帮你做事', '编码代理、电脑操作、受监督的手机操作与循环相机，共享审批、取消与证据核验。'],
    ['可审计的记忆', '本地账本，可选 mem0 / voicemem 召回；读取与模型处理分开授权，真正可遗忘。'],
  ];
  const pillars = en ? [
    ['Proactive', 'Speaks up when it matters, and drafts instead of sending.'],
    ['Memory', 'Source-backed Timeline and Profile that grow as you talk.'],
    ['Interactive', 'Keep talking while the work runs in the background.'],
    ['Voice-first', 'Full-duplex voice with a front brain that talks and a back brain that works.'],
    ['Local-first', 'Your data stays on your devices, encrypted between them.'],
  ] : [
    ['主动', '值得说才开口，只起草，不替你发。'],
    ['记忆', '有出处的 Timeline 与画像，越聊越懂你。'],
    ['可交互', '后台干活，前台照常聊。'],
    ['语音优先', '全双工语音，前脑负责说，后脑负责做。'],
    ['本地优先', '数据留在你的设备上，设备间加密同步。'],
  ];
  const featureGroups = en ? [
    ['workbench', 'Your personal agent'],
    ['tasks', 'Your voice assistant'],
    ['connections', 'Use cases'],
  ] : [
    ['workbench', '你的个人 Agent'],
    ['tasks', '你的语音助手'],
    ['connections', '使用案例'],
  ];
  const cards = featureCards.filter(card => card.lang === (en ? 'en' : 'zh-CN'));
  const tile = (card: (typeof featureCards)[number]) => (
    <article className="feature-tile" key={card.image}>
      <div className="feature-tile-copy"><h3>{card.title}</h3><p>{card.description}</p></div>
      {card.video ? (
        <div className="feature-image-stage feature-video-stage">
          <video controls preload="none" poster={sitePath(card.image)} aria-label={card.alt} width={card.width} height={card.height}>
            <source src={sitePath(card.video)} type="video/mp4" />
            <a href={sitePath(card.video)}>{en ? 'Watch the demo' : '播放演示'}</a>
          </video>
          <a className="feature-video-link" href={sitePath(card.video)}>{en ? 'Open video' : '打开视频'} <ArrowUpRight size={14} /></a>
        </div>
      ) : <a className="feature-image-stage" style={{ aspectRatio: `${card.width} / ${card.height}` }} href={sitePath(card.image)} target="_blank" rel="noreferrer" aria-label={card.alt}><Image src={sitePath(card.image)} alt={card.alt} loading="lazy" width={card.width} height={card.height} /></a>}
      {card.caption && <p className="feature-caption">{card.caption}</p>}
    </article>
  );
  return (
    <>
      <Header en={en} />
      <main id="main">
        <section className="cosmos-hero" id="overview">
          <NovaOrb />
          <div className="hero-content">
            <p className="hero-kicker">
              {en ? 'Your Personal Agent and Voice Assistant · v1.0.0' : '你的个人 Agent 与语音助手 · v1.0.0'}
            </p>
            <h1>Nova Personal Agent</h1>
            <h2>
              {en ? (
                <>
                  Talks while it works.
                  <br />
                  Understands you over time.
                  <br />
                  Stays on your devices.
                </>
              ) : (
                <>边干活边聊天，越聊越懂你，数据留在你的设备上。</>
              )}
            </h2>
            <p className="hero-description">
              {en
                ? 'A voice-first personal agent for your computer and your phone. It acts on your behalf, drafts instead of sending, and shows where its answers come from.'
                : '面向电脑与手机的语音优先个人 Agent。替你动手，只起草不代发，回答都带出处。'}
            </p>
            <div className="hero-actions">
              <a className="button primary" href="#quickstart">
                {en ? 'Download v1.0.0' : '下载 v1.0.0'} <ArrowUpRight size={15} />
              </a>
              <a className="button secondary" href="#film">
                <Play size={14} aria-hidden="true" /> {en ? 'Watch the film' : '观看宣传片'}
              </a>
              <a className="button secondary" href={repo} target="_blank" rel="noreferrer">
                GitHub <ArrowUpRight size={15} />
              </a>
            </div>
          </div>
          <div className="hero-bottom">
            <span aria-hidden="true" />
            <a href="#film" aria-label={en ? 'Explore Nova' : '了解 Nova'}>
              ↓
            </a>
            <span>GPL-3.0-or-later</span>
          </div>
        </section>
        <section className="film-section wrap" id="film" aria-labelledby="film-title">
          <div className="film-heading">
            <p className="section-label">{en ? 'THE FILM' : '宣传片'}</p>
            <h2 id="film-title">{en ? 'A little context. A lot in motion.' : '懂你所想，帮你所需。'}</h2>
            <p className="lead">
              {en
                ? 'A deadline changes. An idea becomes a website. See how Nova keeps work moving while the conversation continues.'
                : '截止日期变了，一个想法变成了网站。看看 Nova 如何理解你的上下文，陪你边聊边做。'}
            </p>
          </div>
          <figure className="film-player">
            <video controls playsInline preload="none" poster={`${film}.webp`} width={1920} height={1080}
              aria-label={en ? 'Nova product film, 720p preview' : 'Nova 产品宣传片，720p 预览'}
              aria-describedby="film-caption">
              <source src={`${film}.mp4`} type="video/mp4" />
              <a href={`${film}.mp4`}>{en ? 'Open the film' : '打开宣传片'}</a>
            </video>
            <figcaption id="film-caption">
              <span>{en ? 'A product scenario film with fictional characters.' : '产品场景演绎，人物为虚构。'}</span>
              <div className="film-links">
                <a href={`${film}.mp4`}>{en ? 'Open video' : '打开视频'} <ArrowUpRight size={14} aria-hidden="true" /></a>
              </div>
            </figcaption>
          </figure>
        </section>
        <section className="intro-section reading" id="demo">
          <p className="section-label">{en ? 'How it fits together' : '它如何运转'}</p>
          <h2>{en ? <>Context in. Work out. Evidence attached.</> : <>理解上下文，把事做成，附上证据。</>}</h2>
          <p className="lead">
            {en
              ? 'Your devices share one Space. Nova draws on the sources you authorize, hands work to specialist executors, and brings back results you can check.'
              : '你的设备共享同一个 Space。Nova 基于你授权的资料，把任务交给专长执行器，并带回可核对的结果。'}
          </p>
        </section>
        <figure className="architecture-overview wrap">
          <a href={arch('light')} aria-label={en ? 'View Nova architecture' : '查看 Nova 架构图'}>
            <Image unoptimized className="only-light" src={arch('light')} alt={en ? 'Nova architecture: devices, Space, conversation, task coordination and specialist executors' : 'Nova 架构：设备、Space、对话、任务协调与专长执行器'} loading="lazy" width={1586} height={992} />
            <Image unoptimized className="only-dark" src={arch('dark')} alt="" aria-hidden="true" loading="lazy" width={1586} height={992} />
          </a>
          <figcaption>{en ? 'Your context informs the conversation. Nova coordinates work, checks results, and speaks when it matters.' : '上下文帮助理解，对话协调执行；结果按证据核对，提醒在合适时机开口。'}</figcaption>
        </figure>
        <section className="home-highlights wrap" id="whats-new" aria-label={en ? 'New in v1.0.0' : 'v1.0.0 新功能'}>
          <p className="section-label whats-new-label">{en ? 'New in v1.0.0' : 'v1.0.0 新功能'}</p>
          {highlights.map(([title, body], i) => <article key={title}><span className="section-label">0{i + 1}</span><h2>{title}</h2><p>{body}</p></article>)}
        </section>
        <section className="main-features wrap" id="features">
          <div className="main-features-heading"><p className="section-label">{en ? 'Work with Nova' : '和 Nova 一起做事'}</p><h2>{en ? 'From context to an outcome.' : '从理解上下文，到把事情做好。'}</h2></div>
          <ol className="pillars">{pillars.map(([title, body]) => <li key={title}><strong>{title}</strong><span>{body}</span></li>)}</ol>
          {featureGroups.map(([group, title], i) => <div key={group}>
            <div className="main-features-heading feature-group-heading" data-index={`0${i + 1}`}><h3>{title}</h3></div>
            <div className="feature-gallery">{cards.filter(card => card.group === group).map(tile)}</div>
          </div>)}
        </section>
        <Gallery en={en} />
        <section className="philosophy" id="design">
          <div className="reading">
            <p className="section-label">
              {en ? 'The thinking behind Nova' : '我们的思考'}
            </p>
            <h2>
              {en ? <>Helpful, not wordy.</> : <>有用，但不啰嗦。</>}
            </h2>
            <p className="lead">
              {en
                ? 'Nova works from the sources you authorize, shows the evidence behind its results, and speaks up only when it matters. You can take over at any time.'
                : 'Nova 只基于你授权的资料工作，给出结果背后的证据，只在值得的时候开口。需要时，你随时可以接管。'}
            </p>
            <div className="architecture-strip">
              <div>
                <small>01</small>
                <strong>{en ? 'Work progresses' : '任务有了进展'}</strong>
                <span>Executor / Runtime blackboard</span>
              </div>
              <span className="flow-arrow">→</span>
              <div>
                <small>02</small>
                <strong>
                  {en ? 'Consider the value' : '判断是否值得告知'}
                </strong>
                <span>Proactive</span>
              </div>
              <span className="flow-arrow">→</span>
              <div>
                <small>03</small>
                <strong>{en ? 'Find the moment' : '等待合适的时机'}</strong>
                <span>Floor / Conversation</span>
              </div>
            </div>
            <a className="text-link" href={doc + '/architecture/'}>
              {en ? 'Explore the personal agent architecture' : '了解个人 Agent 架构'}{' '}
              <ArrowRight size={14} />
            </a>
          </div>
        </section>
        <section className="start-section reading" id="quickstart">
          <p className="section-label">{en ? 'Get started' : '从这里开始'}</p>
          <h2>{en ? 'Your next task starts here.' : '下一件事，交给 Nova。'}</h2>
          <p className="lead">
            {en
              ? 'Install Nova, configure your API keys, and start a conversation.'
              : '安装 Nova，配置 API Key，就可以开始对话。'}
          </p>
          <InstallCommand en={en} />
          <p className="requirements">{en ? 'Upgrading from nova-audio-agent? Uninstall the old npm package before switching names; your local data stays in place.' : '从 nova-audio-agent 升级？切换包名前请先卸载旧 npm 包，本地数据保持不变。'}</p>
          <a className="text-link" href={`${repo}/releases/tag/v1.0.0`}>{en ? 'Read the v1.0.0 release notes and support boundaries' : '查看 v1.0.0 发布说明与支持边界'} <ArrowUpRight size={16} /></a>
          <p className="requirements">
            Node.js 22.13+ · npm ·{' '}
            {en ? 'Install your chosen backend for coding tasks' : '编码任务需安装并登录所选后端'}
          </p>
          <div className="resource-links">
            <a href={doc}>
              {en ? 'Read the documentation' : '阅读使用文档'}{' '}
              <ArrowUpRight size={16} />
            </a>
            <a href={repo} target="_blank" rel="noreferrer">
              {en ? 'Explore the source' : '查看项目源码'}{' '}
              <ArrowUpRight size={16} />
            </a>
          </div>
        </section>
      </main>
      <Footer en={en} />
    </>
  );
}
