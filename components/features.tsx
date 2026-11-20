'use client';
import Image from 'next/image';
import { useState, type ReactNode } from 'react';
import { galleryItems, mediaUrl } from '../lib/gallery';
import { groups, type Clip, type Line } from '../lib/scenes';
import { sitePath } from '../lib/site-path';
import { ClipPlayer, Exchange } from './exchange';
import { Carousel } from './carousel';
import { ClipTabs } from './clip-tabs';
import { ConnectorWall } from './connector-icons';
import { Lightbox, type Shot } from './lightbox';

// Eight things Nova does, each shown with a real recording. Text and media sit
// side by side and swap sides from one section to the next. Wording comes from
// the README, the docs and the v4 film locales.
const mac = (name: string, height: number, width = 1920): Clip => ({
  name,
  device: 'mac',
  width,
  height,
});
const phone = (name: string, height: number): Clip => ({
  name,
  device: 'phone',
  width: 900,
  height,
});
const cut = (name: string): Clip => ({
  name,
  device: 'cut',
  width: 540,
  height: 960,
});
const lines = (id: string): Line[] =>
  groups.flatMap((g) => g.demos).find((d) => d.id === id)!.lines;
const still = (id: string) => galleryItems.find((i) => i.id === id)!;

function Feat({
  id,
  title,
  lede,
  flip = false,
  media,
  children,
}: {
  id: string;
  title: string;
  lede: ReactNode;
  flip?: boolean;
  media: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article
      className={flip ? 'feat feat-flip' : 'feat'}
      id={id}
      aria-labelledby={`${id}-title`}
    >
      <div className="feat-text">
        <h3 id={`${id}-title`}>{title}</h3>
        <p className="feat-lede">{lede}</p>
        {children}
      </div>
      <div className="feat-media">{media}</div>
    </article>
  );
}

export function Features({ en = false }: { en?: boolean }) {
  const lang = en ? 'en' : 'zh-CN';
  const [open, setOpen] = useState<number | null>(null);

  // Every screenshot on this section shares one lightbox; the first three are
  // the carousel in "Built around you".
  const fromStill = (id: string): Shot => {
    const s = still(id);
    return {
      src: sitePath(mediaUrl(s)),
      width: s.width,
      height: s.height,
      title: s.title[lang],
      caption: s.caption[lang],
    };
  };
  const shots: Shot[] = [
    {
      src: sitePath('/media/gallery/pc-timeline.webp'),
      width: 1600,
      height: 940,
      title: 'Timeline',
      caption: en
        ? 'What you said, what came in, what got done, in order.'
        : '说过的话、收到的消息、做完的事，按时间排好。',
    },
    {
      src: sitePath('/media/gallery/pc-profile.webp'),
      width: 1600,
      height: 940,
      title: en ? 'Profile' : '画像',
      caption: en
        ? 'What Nova knows about you. Every entry can be traced, edited or forgotten.'
        : 'Nova 对你的了解，每条都能追溯、修改、遗忘。',
    },
    fromStill('pc-timeline-cited'),
    fromStill('phone-docx'),
    fromStill('phone-dual-brain'),
    fromStill('phone-mobile-result'),
    fromStill('phone-site-file'),
    fromStill('phone-site-dark'),
  ];
  const at = (src: string) =>
    shots.findIndex((s) => s.src.endsWith(`${src}.webp`));
  const phoneShot = (id: string) => {
    const i = at(id);
    return (
      <button
        type="button"
        className="phone-still"
        onClick={() => setOpen(() => i)}
        aria-label={`${shots[i].title}${en ? ', enlarge' : '，放大'}`}
      >
        <Image
          src={shots[i].src}
          alt=""
          width={shots[i].width}
          height={shots[i].height}
          loading="lazy"
          unoptimized
        />
      </button>
    );
  };

  const executors: [string, string][] = en
    ? [
        [
          'Coding',
          'Write code, edit files and run commands in an approved project',
        ],
        ['Computer Use', 'Operate graphical interfaces under approval'],
        ['Mobile Use', 'Run supervised phone automation'],
        [
          'Loop Camera',
          'Watch a chosen camera and report when a condition is met',
        ],
      ]
    : [
        ['Coding', '在已批准的项目中写代码、改文件、跑命令'],
        ['Computer Use', '在审批下操作图形界面'],
        ['Mobile Use', '受控执行手机端操作'],
        ['Loop Camera', '盯住指定摄像头，条件满足时上报'],
      ];

  return (
    <section
      className="features wrap"
      id="features"
      aria-labelledby="features-title"
    >
      <h2 id="features-title">{en ? 'What Nova does' : 'Nova 能做什么'}</h2>
      <div className="features-list">
        <Feat
          id="context"
          title={
            en ? 'Built around you and your context' : '围绕你，和你的上下文'
          }
          lede={
            en
              ? 'Memory grows as you talk. Every entry can be traced, edited or forgotten.'
              : '记忆随对话生长，每条都能追溯、修改、遗忘。'
          }
          media={
            <Carousel
              shots={shots.slice(0, 3)}
              onOpen={(i) => setOpen(() => i)}
              label={
                en ? 'Timeline and Profile screenshots' : 'Timeline 与画像截图'
              }
              en={en}
            />
          }
        >
          <ConnectorWall en={en} />
        </Feat>

        <Feat
          id="intent"
          flip
          title={
            en
              ? 'Asks the one question that matters'
              : '意图理解：只问一个关键问题'
          }
          lede={
            en
              ? 'One question, then a draft. No file changes until you say so.'
              : '问清一个问题再出草案，你没点头，文件不动。'
          }
          media={
            <ClipPlayer
              clip={mac('ask-first', 1128)}
              label={en ? 'Asks before it acts' : '先问清楚，再动手'}
            />
          }
        >
          <Exchange lines={lines('ask')} en={en} />
        </Feat>

        <Feat
          id="one-click"
          title={en ? 'One click to get it done' : '一键完成任务'}
          lede={
            en
              ? 'From a Timeline card, talk it through, or hand it to Build and get a receipt back.'
              : '从 Timeline 卡片直接开聊，或交给 Build，做完附上交付回执。'
          }
          media={
            <ClipTabs
              id="one-click"
              label={en ? 'Recordings' : '录屏'}
              tabs={[
                {
                  key: 'discuss',
                  label: en ? 'Discuss, with sources' : '开聊，带着出处',
                  clip: mac('timeline-discuss', 944, 1600),
                },
                {
                  key: 'build',
                  label: en ? 'Build, at 3× speed' : 'Build，3 倍速',
                  clip: mac('timeline-build', 882, 1600),
                },
              ]}
            />
          }
        />

        <Feat
          id="computer"
          flip
          title={en ? 'Uses your computer' : '替你操作电脑'}
          lede={
            en
              ? 'Finds and likes a video, or writes and tests code. You approve, and can stop it any time.'
              : '搜视频、点赞、写代码、跑测试，你来审批，随时叫停。'
          }
          media={
            <ClipPlayer
              clip={mac('computer-use', 1126)}
              label={en ? 'Uses your computer' : '替你操作电脑'}
            />
          }
        />

        <Feat
          id="phone"
          title={en ? 'Gets things done on your phone' : '手机上原生执行任务'}
          lede={
            en
              ? 'Runs on the phone itself: reads a paper, hands back a Word doc, then talks you through it.'
              : '手机端独立运行：读完论文，交回 Word 文档，再讲给你听。'
          }
          media={
            <div className="phones">
              {phoneShot('phone-docx')}
              <ClipPlayer
                clip={cut('phone-paper')}
                label={
                  en ? 'Reads a paper, hands back a doc' : '读完论文，交回文档'
                }
              />
              {phoneShot('phone-dual-brain')}
            </div>
          }
        />

        <Feat
          id="chat-work"
          flip
          title={en ? 'Chats while it works' : '边聊天，边干活'}
          lede={
            en
              ? 'Keep reading your novel. Ask for lunch by voice, and Nova picks it while you read.'
              : '你看你的小说，动动嘴，Nova 在旁边帮你挑外卖。'
          }
          media={
            <div className="phones phones-two">
              <ClipPlayer
                clip={cut('phone-lunch')}
                label={en ? 'Orders lunch while you read' : '看书时帮你挑外卖'}
              />
              {phoneShot('phone-mobile-result')}
            </div>
          }
        >
          <Exchange lines={lines('phone')} en={en} />
        </Feat>

        <Feat
          id="executors"
          title={en ? 'Your own executors' : '你专属的执行器'}
          lede={
            en
              ? 'Work runs in the background while you keep talking. Nova handles permissions and delivery.'
              : '后台干活，前台照聊，权限和交付由 Nova 统一管。'
          }
          media={
            <div className="phones">
              {phoneShot('phone-site-file')}
              <ClipPlayer
                clip={cut('phone-site-v2')}
                label={
                  en ? 'Builds a website from one sentence' : '一句话做个网站'
                }
              />
              {phoneShot('phone-site-dark')}
            </div>
          }
        >
          <table className="exec">
            <tbody>
              {executors.map(([name, use]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Feat>

        <Feat
          id="relay"
          flip
          title={
            en
              ? 'Start on your laptop, pick up on your phone'
              : '电脑聊一半，手机接着聊'
          }
          lede={
            en
              ? 'Heading out? Pick up where you left off, synced end-to-end encrypted.'
              : '出门不用从头说，设备间端到端加密同步。'
          }
          media={
            <div className="combo">
              <ClipPlayer
                clip={mac('handoff-mac', 1128)}
                label={en ? 'Start on the Mac' : '电脑上开始'}
              />
              <ClipPlayer
                clip={phone('handoff-iphone', 1972)}
                label={en ? 'Continue on the iPhone' : '手机上接着看'}
              />
            </div>
          }
        >
          <Exchange lines={lines('devices')} en={en} />
        </Feat>
      </div>
      <p className="features-note">
        {en
          ? 'Real screen recordings on a persona test account, translated from Chinese.'
          : '均为真实录屏，使用人设测试账号。'}
      </p>
      <Lightbox shots={shots} open={open} setOpen={setOpen} en={en} />
    </section>
  );
}
