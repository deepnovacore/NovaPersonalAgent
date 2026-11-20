import type { ReactNode } from 'react';
import { CalendarDays, FolderOpen, Mail, MessagesSquare } from 'lucide-react';

// Brand marks for Gmail, Google Calendar and MCP come from Simple Icons
// (CC0, simple-icons@16.38.0). Simple Icons has no Feishu, Apple Mail or
// Apple Calendar mark, so those use a lucide glyph on the product's colour.
const mark = (d: string) => (
  <svg
    viewBox="0 0 24 24"
    width={28}
    height={28}
    aria-hidden="true"
    focusable="false"
  >
    <path fill="currentColor" d={d} />
  </svg>
);
const glyph = (Icon: typeof Mail) => (
  <Icon size={28} strokeWidth={1.9} aria-hidden="true" />
);

type Item = { id: string; name: [string, string]; icon: ReactNode };
const ITEMS: Item[] = [
  {
    id: 'folder',
    name: ['本地文件夹', 'Local folders'],
    icon: glyph(FolderOpen),
  },
  { id: 'mail', name: ['macOS 邮件', 'macOS Mail'], icon: glyph(Mail) },
  {
    id: 'calendar',
    name: ['macOS 日历', 'macOS Calendar'],
    icon: glyph(CalendarDays),
  },
  {
    id: 'gmail',
    name: ['Gmail', 'Gmail'],
    icon: mark(
      'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
    ),
  },
  {
    id: 'gcal',
    name: ['Google 日历', 'Google Calendar'],
    icon: mark(
      'M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z',
    ),
  },
  { id: 'feishu', name: ['飞书', 'Feishu'], icon: glyph(MessagesSquare) },
  {
    id: 'mcp',
    name: ['MCP', 'MCP'],
    icon: mark(
      'M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245',
    ),
  },
];

export function ConnectorWall({ en = false }: { en?: boolean }) {
  return (
    <div className="connectors">
      <p>
        {en
          ? 'Nova reads only what you connect, and asks before a model sees it.'
          : '只读你连接的资料，交给模型前先问你。'}
      </p>
      <ul>
        {ITEMS.map((item) => (
          <li key={item.id}>
            <span className={`cx cx-${item.id}`}>{item.icon}</span>
            {item.name[en ? 1 : 0]}
          </li>
        ))}
      </ul>
    </div>
  );
}
