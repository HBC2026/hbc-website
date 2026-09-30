'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useApp } from './Providers';
import { asset, isConfigured } from '@/lib/supabase';
import { fmtLongDate } from '@/lib/format';
import { ATTENDANCE_SIDE, PAYROLL_SIDE, QUOTE_SIDE, ROLE_LABEL } from '@/lib/roles';
import type { Role } from '@/lib/types';

interface NavItem { href: string; label: string; icon: string; roles?: Role[] }
interface NavGroup { label: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { label: 'WORKSPACE', items: [{ href: '/', label: 'Dashboard', icon: '⌂' }] },
  {
    label: 'PAYROLL', items: [
      { href: '/employees', label: 'Employees', icon: '♙', roles: ATTENDANCE_SIDE },
      { href: '/attendance', label: 'Daily Attendance', icon: '◧', roles: ATTENDANCE_SIDE },
      { href: '/attendance/monthly', label: 'Monthly Attendance', icon: '▦', roles: ATTENDANCE_SIDE },
      { href: '/payroll', label: 'Payroll', icon: '◫', roles: PAYROLL_SIDE },
      { href: '/slips', label: 'Salary Slips', icon: '✎', roles: PAYROLL_SIDE },
      { href: '/archive', label: 'Payroll Archive', icon: '▣', roles: PAYROLL_SIDE },
    ],
  },
  { label: 'QUOTATIONS', items: [{ href: '/quotations', label: 'Quotations', icon: '▤', roles: QUOTE_SIDE }] },
  { label: 'SYSTEM', items: [
    { href: '/audit', label: 'Audit Log', icon: '◈' },
    { href: '/settings', label: 'Settings', icon: '⚙', roles: ['administrator'] },
  ] },
];

const ALL = NAV.flatMap((g) => g.items);

function activeHref(pathname: string): string | undefined {
  return ALL.filter((i) => (i.href === '/' ? pathname === '/' : pathname === i.href || pathname.startsWith(i.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { loading, userId, profile, signOut } = useApp();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => { if (!loading && isConfigured && !userId) router.replace('/login'); }, [loading, userId, router]);

  if (!isConfigured) {
    return (
      <div className="login-wrap"><div className="login-card">
        <h1>Supabase not configured</h1>
        <p className="sub">Copy <code>.env.example</code> to <code>.env.local</code>, add your project URL and anon key, then restart the dev server.</p>
      </div></div>
    );
  }
  if (loading || !userId) return <div className="login-wrap"><div className="muted">Loading…</div></div>;
  if (!profile) {
    return (
      <div className="login-wrap"><div className="login-card">
        <h1>No profile found</h1>
        <p className="sub">Your account has no profile row. Run the migrations (the profile trigger creates it on sign-up) or ask an administrator.</p>
        <button className="btn" onClick={signOut}>Sign out</button>
      </div></div>
    );
  }

  const current = activeHref(pathname);
  const currentLabel = ALL.find((i) => i.href === current)?.label ?? 'Portal';
  const initials = profile.full_name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || 'U';

  return (
    <>
      <aside className="sidebar no-print">
        <div className="brand">
          <Link href="/" className="brand-logo" aria-label="Hassan and Bilal Company"><img src={asset('/hbc-logo.webp')} alt="Hassan and Bilal Company" /></Link>
          <div className="brand-subtitle">Administration Portal</div>
        </div>

        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.roles || i.roles.includes(profile.role));
          if (!items.length) return null;
          return (
            <div key={g.label}>
              <div className="nav-label">{g.label}</div>
              {items.map((i) => (
                <Link key={i.href} href={i.href} className={`nav-item${current === i.href ? ' active' : ''}`}>
                  <span className="nav-icon">{i.icon}</span>{i.label}
                </Link>
              ))}
            </div>
          );
        })}

        <div className="nav-label">COMING LATER</div>
        <div className="nav-item disabled"><span className="nav-icon">▧</span>Invoices<span className="coming-soon">SOON</span></div>

        <div className="sidebar-footer">
          <div className="user">
            <div className="avatar">{initials}</div>
            <div>
              <div className="user-name">{profile.full_name}</div>
              <div className="user-role">{ROLE_LABEL[profile.role]}</div>
            </div>
            <button className="signout" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar no-print">
          <div className="breadcrumb">HBC &nbsp;/&nbsp; <strong>{currentLabel}</strong></div>
          <div className="date">{fmtLongDate(new Date())}</div>
        </header>
        <div className="content">{children}</div>
      </main>
    </>
  );
}
