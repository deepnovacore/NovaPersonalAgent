/* oxlint-disable jsx-a11y/media-has-caption -- Keep the supplied original demo without added subtitles. */
import Image from 'next/image';
import { featureCards } from '../lib/home-features';
import { sitePath } from '../lib/site-path';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Header, Footer, repo } from './site-header';
import { InstallCommand } from './install-command';
import { StarField } from './star-field';
import { HeroHeaderScope } from './hero-header-scope';
export function HomePage({ en = false }: { en?: boolean }) {
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const highlights = en ? [
    ['A persistent home and Timeline', 'Keep Nova beside your tabbed workspace. Revisit context, evidence and task results without leaving the conversation.'],
    ['Scheduled Agent Tasks', 'Run work once, daily or weekly. Manage schedules on desktop or mobile and receive reports in your main conversation.'],
    ['Understanding that grows', 'Authorized sources sync incrementally. Resumable processing builds an editable Profile with evidence you can check and withdraw.'],
    ['Choose your coding agent', 'Codex, OpenCode, CodeBuddy, Pi or DeepSeek Harness: each session keeps its backend, with improved recovery and Windows support.'],
    ['Control every step', 'Approvals, cancellation and evidence checks connect specialist execution. GUI and phone execution remain experimental.'],
  ] : [
    ['持续主会话与 Timeline', 'Nova 陪在标签工作区旁，随时回看上下文、来源证据和任务结果，不必离开对话。'],
    ['定时 Agent 任务', '支持单次、每日、每周运行，在桌面端或手机端管理，报告回到主会话。'],
    ['逐步积累对你的理解', '授权来源增量同步，可恢复的处理逐步更新画像；内容可编辑，引用可核对，来源可撤回。'],
    ['选择你的编码代理', 'Codex、OpenCode、CodeBuddy、Pi 或 DeepSeek Harness，会话保留原后端，恢复流程和 Windows 支持持续完善。'],
    ['执行有授权，结果有证据', '专长执行共享审批、取消和证据核验。GUI 与手机执行继续作为实验能力提供。'],
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
      <Header en={en} hero />
      <HeroHeaderScope />
      <main id="main">
        <section className="cosmos-hero theme-dark" id="overview">
          <StarField en={en} />
          <div className="hero-content">
            <p className="hero-kicker">
              {en ? 'Your Personal Agent and Voice Assistant' : '你的个人 Agent 与语音助手'}
            </p>
            <h1>
              Nova Personal Agent
            </h1>
            <h2>
              {en ? (
                <>
                  Knows your context.
                  <br />
                  Gets things done.
                </>
              ) : (
                <>懂你的上下文，把事做成。</>
              )}
            </h2>
            <p className="hero-description">
              {en
                ? 'A persistent conversation, scheduled tasks and source-backed understanding, beside your everyday workspace.'
                : '持续主会话、定时任务与有出处的理解，陪在日常工作区旁。'}
            </p>
            <div className="hero-actions">
              <a className="button primary" href={doc}>
                {en ? 'Get started' : '开始使用'} <ArrowUpRight size={15} />
              </a>
            </div>
          </div>
          <div className="hero-bottom">
            <span aria-hidden="true" />
            <a href="#demo" aria-label={en ? 'Explore Nova' : '了解 Nova'}>
              ↓
            </a>
            <span>Apache 2.0</span>
          </div>
        </section>
        <section className="intro-section reading" id="demo">
          <p className="section-label">{en ? 'New in v0.4.0' : 'v0.4.0 新功能'}</p>
          <h2>
            {en ? <>Remembers what matters.</> : <>记住重要的事。</>}
          </h2>
          <p className="lead">
            {en
              ? 'Talk through a goal, organize your todos, ideas and goals on the Workbench, and follow delegated work through to an evidence-backed result. Nova draws on the sources you authorize, keeps memory traceable, and lets you take over whenever you need.'
              : '一起问清目标，在 Workbench 中整理待办、想法与目标，再跟进任务直到得到有证据的结果。Nova 结合你授权的资料，保留记忆出处；需要时，你随时可以接管。'}
          </p>
        </section>
        <figure className="architecture-overview wrap">
          <a href={sitePath(`/doc-assets/assets/architecture/nova-personal-agent.${en ? 'en' : 'zh-CN'}.png`)} aria-label={en ? 'View Nova architecture' : '查看 Nova 架构图'}>
            <Image src={sitePath(`/doc-assets/assets/architecture/nova-personal-agent.${en ? 'en' : 'zh-CN'}.png`)} alt={en ? 'Nova personal agent: app context, conversation, task coordination and specialist execution' : 'Nova 个人 Agent：应用上下文、对话、任务协调与专长执行'} loading="lazy" width={1586} height={992} />
          </a>
          <figcaption>{en ? 'Your context informs the conversation. Nova coordinates work, checks results, and speaks when it matters.' : '上下文帮助理解，对话协调执行；结果按证据核对，提醒在合适时机开口。'}</figcaption>
        </figure>
        <section className="home-highlights wrap" id="whats-new" aria-label={en ? 'Highlights' : '核心特性'}>
          {highlights.map(([title, body], i) => <article key={title}><span className="section-label">0{i + 1}</span><h2>{title}</h2><p>{body}</p></article>)}
        </section>
        <section className="main-features wrap" id="features">
          <div className="main-features-heading"><p className="section-label">{en ? 'Work with Nova' : '和 Nova 一起做事'}</p><h2>{en ? 'From context to an outcome.' : '从理解上下文，到把事情做好。'}</h2></div>
          {featureGroups.map(([group, title], i) => <div key={group}>
            <div className="main-features-heading feature-group-heading" data-index={`0${i + 1}`}><h3>{title}</h3></div>
            <div className="feature-gallery">{cards.filter(card => card.group === group).map(tile)}</div>
          </div>)}
        </section>
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
          <a className="text-link" href={`${repo}/releases/tag/v0.4.0`}>{en ? 'Read the v0.4.0 release notes and support boundaries' : '查看 v0.4.0 发布说明与支持边界'} <ArrowUpRight size={16} /></a>
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
