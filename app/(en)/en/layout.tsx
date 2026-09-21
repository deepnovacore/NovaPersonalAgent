import { sitePath } from '../../../lib/site-path';
import type { Metadata } from 'next';
import { ThemeScript } from '../../../components/theme-script';
import '../../globals.css';
export const metadata: Metadata = {
  title: 'Nova Audio Agent — Stay in conversation. Keep work moving.',
  description:
    'Real-time voice, background tasks, camera monitoring, personal memory, and document knowledge. Nova speaks up when it matters.',
  icons: { icon: sitePath('/favicon.svg') },
  alternates: { languages: { 'zh-CN': sitePath('/'), en: sitePath('/en') } },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html suppressHydrationWarning lang="en">
      <body>
        <ThemeScript />
        {children}
      </body>
    </html>
  );
}
