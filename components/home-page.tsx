import { featureCards } from '../lib/home-features';
import { YouTubeCard } from './youtube-card';
import { sitePath } from '../lib/site-path';
import { ArrowRight, ArrowUpRight, Play } from 'lucide-react';
import { Header, Footer, repo } from './site-header';
import { InstallCommand } from './install-command';
import { StarField } from './star-field';
import { HeroHeaderScope } from './hero-header-scope';
export function HomePage({ en = false }: { en?: boolean }) {
  const doc = sitePath(en ? '/en/docs' : '/docs');
  const highlights = en ? [
    ['Real-time conversation', 'Keep talking while tasks run. Clarify a request or change direction whenever you need.'],
    ['Thoughtfully proactive', 'Nova reports meaningful progress and camera events, while routine updates stay quiet.'],
    ['Context that stays with you', 'Recall personal memories and your documents. Keep control through explicit approvals.'],
  ] : [
    ['边聊边做', '后台任务继续，前台对话照常。随时澄清需求、补充要求，或调整方向。'],
    ['主动有分寸', '重要进展、关注的画面变化，及时提醒；琐碎过程保持安静，不抢你说话。'],
    ['理解你的上下文', '结合个人记忆与知识库回答问题，需要授权时先确认，决定权始终在你。'],
  ];
  return (
    <>
      <Header en={en} hero />
      <HeroHeaderScope />
      <main id="main">
        <section className="cosmos-hero theme-dark" id="overview">
          <StarField en={en} />
          <div className="hero-content">
            <p className="hero-kicker">
              {en ? 'A voice agent by DeepNovaCore' : '深穹星核 · 开源语音助手'}
            </p>
            <h1>
              NovaAudioAgent
            </h1>
            <h2>
              {en ? (
                <>
                  Stay in conversation.
                  <br />
                  Keep work moving.
                </>
              ) : (
                <>随时交流，专心做事。</>
              )}
            </h2>
            <p className="hero-description">
              {en
                ? 'A voice agent that listens, remembers, and acts. Talk naturally, explore your documents, or ask Nova to watch for changes—and hear back when it matters.'
                : '能对话、会记忆、也能行动的常驻语音助手。自然交流、查询资料、观察画面，让小诺在值得你关注时主动开口。'}
            </p>
            <div className="hero-actions">
              <a className="button primary" href={doc}>
                {en ? 'Get started' : '开始使用'} <ArrowUpRight size={15} />
              </a>
              <a className="button secondary" href="#demo">
                <Play size={12} />
                {en ? 'Watch on YouTube' : 'YouTube 演示'}
              </a>
            </div>
          </div>
          <div className="hero-bottom">
            <span>
              {en
                ? 'Always present. Thoughtfully proactive.'
                : '常驻在线，主动有分寸。'}
            </span>
            <a href="#demo" aria-label={en ? 'Explore Nova' : '了解 Nova'}>
              ↓
            </a>
            <span>Apache 2.0</span>
          </div>
        </section>
        <section className="intro-section reading" id="demo">
          <p className="section-label">{en ? 'Meet Nova' : '认识小诺'}</p>
          <h2>
            {en ? (
              <>
                A little less switching.
                <br />A little more doing.
              </>
            ) : (
              <>
                少一点来回切换，
                <br />
                多一点专心做事。
              </>
            )}
          </h2>
          <p className="lead">
            {en
              ? 'Nova connects real-time voice with background tasks, camera monitoring, personal memory, and document knowledge. Stay in conversation on your desktop or from your iPhone.'
              : '小诺常驻桌面，把实时语音、后台执行、视觉监控、个人记忆和知识库连在一起，也能通过 iPhone 随身连接。'}
          </p>
        </section>
        <div className="demo-media wrap"><YouTubeCard en={en} /></div>
        <section className="home-highlights wrap" aria-label={en ? 'Highlights' : '核心特性'}>
          {highlights.map(([title, body], i) => <article key={title}><span className="section-label">0{i + 1}</span><h2>{title}</h2><p>{body}</p></article>)}
        </section>
        <section className="main-features wrap" id="features">
          <div className="main-features-heading"><p className="section-label">{en ? 'Main features' : '核心功能'}</p><h2>{en ? 'More ways to work with Nova.' : '从一句话，到更多可能。'}</h2></div>
          <div className="feature-gallery">{featureCards.filter(card => card.lang === (en ? 'en' : 'zh-CN')).map(card => <article className="feature-tile" key={card.image}>
            <div className="feature-tile-copy"><h3>{card.title}</h3><p>{card.description}</p></div>
            <a className="feature-image-stage" href={sitePath(card.image)} target="_blank" rel="noreferrer" aria-label={card.alt}><img src={sitePath(card.image)} alt={card.alt} loading="lazy" width={1280} height={1280} /></a>
            {card.caption && <p className="feature-caption">{card.caption}</p>}
          </article>)}</div>
        </section>
        <section className="philosophy" id="design">
          <div className="reading">
            <p className="section-label">
              {en ? 'The thinking behind Nova' : '我们的思考'}
            </p>
            <h2>
              {en ? (
                <>
                  Knowing what to say.
                  <br />
                  And when to say it.
                </>
              ) : (
                <>
                  知道怎么回答，
                  <br />
                  也知道何时开口。
                </>
              )}
            </h2>
            <p className="lead">
              {en
                ? 'An update is only useful if it deserves your attention. Nova treats doing the work and deciding when to speak as separate responsibilities.'
                : '并非每一条进度，都值得打断你。Nova 将“把事做好”和“何时告知”分开考虑，让任务持续推进，也让你的注意力得到尊重。'}
            </p>
            <div className="architecture-strip">
              <div>
                <small>01</small>
                <strong>{en ? 'Work progresses' : '任务有了进展'}</strong>
                <span>Executor / Memory</span>
              </div>
              <span className="flow-arrow">→</span>
              <div>
                <small>02</small>
                <strong>
                  {en ? 'Consider the value' : '判断是否值得告知'}
                </strong>
                <span>Surrogate</span>
              </div>
              <span className="flow-arrow">→</span>
              <div>
                <small>03</small>
                <strong>{en ? 'Find the moment' : '等待合适的时机'}</strong>
                <span>Floor / Voice</span>
              </div>
            </div>
            <a className="text-link" href={doc + '/architecture/'}>
              {en ? 'Explore the architecture' : '了解运行时架构'}{' '}
              <ArrowRight size={14} />
            </a>
          </div>
        </section>
        <section className="start-section reading" id="quickstart">
          <p className="section-label">{en ? 'Get started' : '从这里开始'}</p>
          <h2>{en ? 'Your next task starts here.' : '下一件事，交给小诺。'}</h2>
          <p className="lead">
            {en
              ? 'Install Nova, configure your API keys, and start a conversation.'
              : '安装 Nova，配置 API Key，就可以开始对话。'}
          </p>
          <InstallCommand en={en} />
          <p className="requirements">
            Node.js 22+ · npm ·{' '}
            {en ? 'Codex required for coding tasks' : '编码任务需另行安装并登录 Codex'}
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
