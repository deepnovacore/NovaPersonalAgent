// Lines are what was actually said or typed in the screen recordings.
// Whisper's mishearings are corrected (七月→栖野, 曹稿→草稿, 每团→美团, 牛腊→牛腩);
// "……" marks where a line continues beyond what can be read or heard.
// Sources: nova-v1-launch-work/findings/transcripts/R0x.srt and the B1/B3
// frame captures in nova-usecase-pr/assets/2026-11-15-masked/audit/b.

export type Line = { who: 'you' | 'nova'; zh: string; en: string };
export type Text = { zh: string; en: string };
export type Clip = {
  name: string;
  device: 'mac' | 'phone';
  width: number;
  height: number;
};
// One demo: a short capability label, one or more recordings of the same
// moment, and the transcript, which the page keeps folded.
export type Demo = { id: string; label: Text; clips: Clip[]; lines: Line[] };
export type Group = {
  id: string;
  title: Text;
  demos: Demo[];
  stills: string[];
};

const mac = (name: string, height = 1126): Clip => ({
  name,
  device: 'mac',
  width: 1920,
  height,
});
const phone = (name: string, height = 2002): Clip => ({
  name,
  device: 'phone',
  width: 900,
  height,
});

export const groups: Group[] = [
  {
    id: 'talk',
    title: { zh: '边干活边聊天', en: 'Talks while it works' },
    demos: [
      {
        id: 'phone',
        label: { zh: '手机上帮你点外卖', en: 'Orders lunch on your phone' },
        clips: [phone('mobile-use')],
        lines: [
          {
            who: 'you',
            zh: '我现在有点饿。请你帮我在手机上的美团应用里，看看中午有哪些好吃的，给我推荐几道菜。',
            en: 'I’m a bit hungry. Open Meituan on my phone and see what’s good for lunch. Recommend a few dishes.',
          },
          {
            who: 'nova',
            zh: '美团已经打开了，我帮你找到几家适合中午吃的店。推荐一碗牛腩饭的番茄牛腩饭单人餐……',
            en: 'Meituan is open. I found a few places that work for lunch. There’s a tomato beef brisket rice set for one…',
          },
          {
            who: 'you',
            zh: '这个牛腩饭多少钱？',
            en: 'How much is the beef brisket rice?',
          },
          {
            who: 'nova',
            zh: '页面上显示这家牛腩饭的人均是 18 元，但具体套餐价格数字显示不太全。如果你需要更详细的价格，我可以帮你点进去查看。',
            en: 'The page says about 18 yuan per person, but the set price is cut off. If you want the exact price, I can open the listing.',
          },
        ],
      },
      {
        id: 'site',
        label: {
          zh: '一句话做个网站',
          en: 'Builds a website from one sentence',
        },
        clips: [phone('phone-site')],
        lines: [
          {
            who: 'you',
            zh: '请你帮我写一个我的个人网站。结合我的项目经历和我个人的材料，然后我想去发给别人求职。',
            en: 'Make me a personal website from my project history and my own materials. I want to send it out when I apply for jobs.',
          },
          {
            who: 'nova',
            zh: '我来帮你搭建一个个人网站，结合你的项目经历和个人材料，用于求职展示。让我先调用你的个人档案信息，然后创建一个简洁专业的作品集网站。',
            en: 'I’ll build a personal site from your projects and materials for job applications. First I’ll pull up your profile, then make a clean, professional portfolio.',
          },
        ],
      },
      {
        id: 'docx',
        label: {
          zh: '读完论文，交回文档',
          en: 'Reads a paper, hands back a doc',
        },
        clips: [phone('phone-docx')],
        lines: [],
      },
    ],
    stills: [
      'phone-mobile-result',
      'phone-voice-site',
      'phone-site-file',
      'phone-site-result',
      'phone-site-dark',
    ],
  },
  {
    id: 'learn',
    title: { zh: '越聊越懂你', en: 'Learns you as you talk' },
    demos: [
      {
        id: 'morning',
        label: { zh: '早上先开口', en: 'Speaks first in the morning' },
        clips: [mac('morning-brief', 1134)],
        lines: [
          {
            who: 'nova',
            zh: '知远，早上好。今天先从两件最清楚的事开始吧。',
            en: 'Morning, Zhiyuan. Let’s start with the two clearest things today.',
          },
          {
            who: 'nova',
            zh: '山间市集，主视觉等周砚确认。作品集首页，v2 已签核。下午想骑车，给自己留一段空档。',
            en: 'Mountain market: key visual waiting on Zhou Yan. Portfolio home page: v2 signed off. You wanted to ride this afternoon, so keep a gap free.',
          },
        ],
      },
      {
        id: 'invite',
        label: {
          zh: '记得你不爱去的场合',
          en: 'Remembers what you’d rather skip',
        },
        clips: [mac('proactive-draft')],
        lines: [
          {
            who: 'nova',
            zh: '栖野设计周发来一封邀请，11 月 21 日下午一点到四点半的设计师圆桌和酒会。不过你那天安排了安吉骑行，你之前也说过不太想去这种人多、以社交为主的活动。要我帮你婉拒吗？',
            en: 'Qiye Design Week sent an invite: a designers’ roundtable and drinks, November 21, 1 to 4:30 pm. You’ve planned a ride in Anji that day, and you’ve said before you’d rather skip crowded, social-heavy events. Want me to decline?',
          },
          {
            who: 'you',
            zh: '我不想去，帮我拒绝吧。',
            en: 'I don’t want to go. Turn it down for me.',
          },
          {
            who: 'nova',
            zh: '好的，我来帮你起草一封婉拒的回复草稿，只保存到邮箱草稿箱，不会发送。',
            en: 'Okay. I’ll draft a polite decline and save it to your Drafts folder. It won’t be sent.',
          },
        ],
      },
      {
        id: 'ask',
        label: { zh: '先问清楚，再动手', en: 'Asks before it acts' },
        clips: [mac('ask-first', 1128)],
        lines: [
          {
            who: 'you',
            zh: '山间市集的主视觉，我想再调整一下。',
            en: 'I want to rework the key visual for the mountain market.',
          },
          {
            who: 'nova',
            zh: '主视觉这块现在最要紧的是先有周砚的书面结论，不然调整没有落点。你是想调哪部分……',
            en: 'What matters most right now is a written decision from Zhou Yan; without it the changes have nothing to land on. Which part do you want to change…',
          },
          {
            who: 'nova',
            zh: '按你保留暖灰底、苔绿标题、展名不改、旧稿只留档来理，三步草案是这样。……这次只出草案，没动任何文件。',
            en: 'Keeping the warm grey background, the moss-green title and the show name, with old drafts archived only, here is a three-step draft. … This is only a draft; no files were touched.',
          },
        ],
      },
    ],
    stills: [
      'pc-morning-brief',
      'pc-timeline-cited',
      'iphone-morning',
      'iphone-feed',
    ],
  },
  {
    id: 'act',
    title: { zh: '替你动手', en: 'Does it for you' },
    demos: [
      {
        id: 'computer',
        label: { zh: '替你操作电脑', en: 'Uses your computer' },
        clips: [mac('computer-use')],
        lines: [
          {
            who: 'nova',
            zh: '刚才你让我帮你写一个番茄计时器。我回复说已暂停，做过的步骤都保留了。你可以回复继续接着做。',
            en: 'You asked me to build a pomodoro timer. I paused it, and every step so far is kept. Reply and I’ll pick it up again.',
          },
          {
            who: 'nova',
            zh: '好的，我会继续完成番茄计时器的任务。',
            en: 'Okay, I’ll carry on with the pomodoro timer.',
          },
        ],
      },
      {
        id: 'devices',
        label: {
          zh: '电脑上说，手机上接着说',
          en: 'Start on the Mac, carry on from the phone',
        },
        clips: [mac('handoff-mac', 1128), phone('handoff-iphone', 1972)],
        lines: [
          {
            who: 'you',
            zh: '周末下午想放松一下，给我两个附近的安排，每个一句话，先不预订。',
            en: 'I want to unwind on Saturday afternoon. Give me two things nearby, one sentence each, no bookings yet.',
          },
          {
            who: 'nova',
            zh: '一、下午两点去骑山路坡段那条线，想停就停。二、找家附近安静的咖啡馆坐坐，顺手理一理山间市集的照片。都不用预订。',
            en: 'One: ride the hill route at 2 pm and stop whenever you like. Two: find a quiet café nearby and sort the mountain market photos while you’re there. Neither needs booking.',
          },
          {
            who: 'you',
            zh: '把刚才第二个方案压缩成三条行动，每条不超过十个字。',
            en: 'Turn the second one into three actions, ten characters or fewer each.',
          },
          {
            who: 'nova',
            zh: '一、挑附近安静的咖啡馆。二、带上集市旧稿照片。三、想停就停，累了就收。',
            en: 'One: pick a quiet café nearby. Two: bring the old market photos. Three: stop when you’re tired.',
          },
        ],
      },
    ],
    stills: ['pc-computer-use', 'pc-build-receipt'],
  },
];
