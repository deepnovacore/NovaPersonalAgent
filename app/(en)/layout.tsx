import { sitePath } from '../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../components/theme-script';
import '../globals.css';
export const metadata: Metadata = {
  title: 'Nova Personal Agent — Your Personal Agent and Voice Assistant',
  description: 'Your personal agent and voice assistant: todos, ideas and goals on one workbench, memory you can trace, and tasks checked against evidence.',
  icons: { icon: { url: sitePath('/brand/nova-icon.png'), type: 'image/png' }, apple: sitePath('/brand/nova-icon.png') },
  alternates: { languages: { en: sitePath('/'), 'zh-CN': sitePath('/zh'), 'x-default': sitePath('/') } },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning lang="en">
      <head>
        {/* Brand type (outline/brand): Inter + 思源黑体 (Noto Sans SC). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400..800&family=Noto+Sans+SC:wght@400;500;700;900&family=JetBrains+Mono:wght@500&display=swap"
        />
      </head>
      <body>
        <ThemeScript />
        {children}
      </body>
    </html>
  );
}
