import type { Metadata } from 'next';
import { DM_Sans, Manrope } from 'next/font/google';
import { Providers } from '@/components/Providers';
import './globals.css';

const manrope = Manrope({ subsets: ['latin'], weight: ['500', '600', '700', '800'], variable: '--font-manrope' });
const dmSans = DM_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-dm-sans' });

export const metadata: Metadata = {
  title: 'HBC Administration Portal',
  description: 'Hassan and Bilal Company — internal payroll and quotation administration',
  robots: { index: false, follow: false },
  icons: { icon: '/hbc-logo.webp' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${dmSans.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
