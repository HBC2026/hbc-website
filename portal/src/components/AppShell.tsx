'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from './Providers';
import { Select } from './ui';
import { isConfigured } from '@/lib/supabase';
import { fmtLongDate } from '@/lib/format';
import { ATTENDANCE_SIDE, PAYROLL_SIDE, PETTY_SIDE, QUOTE_SIDE, ROLE_LABEL } from '@/lib/roles';
import type { Role } from '@/lib/types';

interface NavItem { href: string; label: string; icon: string; roles?: Role[] }
interface NavGroup { label: string; icon: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { label: 'Workspace', icon: '⌂', items: [{ href: '/adminconsole', label: 'Dashboard', icon: '⌂' }] },
  {
    label: 'Payroll', icon: '◫', items: [
      { href: '/adminconsole/employees', label: 'Employees', icon: '♙', roles: ATTENDANCE_SIDE },
      { href: '/adminconsole/attendance', label: 'Attendance', icon: '◧', roles: ATTENDANCE_SIDE },
      { href: '/adminconsole/payroll', label: 'Payroll', icon: '◫', roles: PAYROLL_SIDE },
      { href: '/adminconsole/slips', label: 'Salary Slips', icon: '✎', roles: PAYROLL_SIDE },
      { href: '/adminconsole/archive', label: 'Payroll Archive', icon: '▣', roles: PAYROLL_SIDE },
    ],
  },
  {
    label: 'Quotations', icon: '▤', items: [
      { href: '/adminconsole/quotations', label: 'Quotations', icon: '▤', roles: QUOTE_SIDE },
      { href: '/adminconsole/clients', label: 'Clients', icon: '♖', roles: QUOTE_SIDE },
    ],
  },
  { label: 'Petty Cash', icon: '◉', items: [{ href: '/adminconsole/pettycash', label: 'Petty Cash', icon: '◉', roles: PETTY_SIDE }] },
  { label: 'System', icon: '⚙', items: [
    { href: '/adminconsole/audit', label: 'Audit Log', icon: '◈' },
    { href: '/adminconsole/settings', label: 'Settings', icon: '⚙', roles: ['administrator'] },
  ] },
];

const ALL = [...NAV.flatMap((g) => g.items), { href: '/adminconsole/overview', label: 'All Companies', icon: '◈' }];

function activeHref(pathname: string): string | undefined {
  return ALL.filter((i) => (i.href === '/adminconsole' ? pathname === i.href : pathname === i.href || pathname.startsWith(i.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function AppShell({ children }: { children: ReactNode }) {
  const { loading, userId, profile, company, companies, switchCompany, signOut } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);   // phone-size slide-out menu
  useEffect(() => setNavOpen(false), [pathname]);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});   // submenu overrides; unset = open only if it holds the current page
  useEffect(() => setOpenGroups({}), [pathname]);

  // Label every table cell with its column header so phone layouts can stack rows as cards (see .table in globals.css).
  useEffect(() => {
    const label = () => {
      document.querySelectorAll<HTMLTableElement>('table.table:not(.sheet)').forEach((t) => {
        const heads = Array.from(t.querySelectorAll('thead th')).map((h) => (h.textContent ?? '').trim());
        if (!heads.length) return;
        t.querySelectorAll('tbody tr, tfoot tr').forEach((tr) => {
          let col = 0;
          Array.from(tr.children).forEach((c) => {
            const td = c as HTMLTableCellElement;
            const l = td.colSpan > 1 ? '' : heads[col] ?? '';
            if (td.getAttribute('data-label') !== l) td.setAttribute('data-label', l);
            col += td.colSpan;
          });
        });
      });
    };
    label();
    const mo = new MutationObserver(label);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, []);

  useEffect(() => { if (!loading && isConfigured && !userId) router.replace('/adminconsole/login'); }, [loading, userId, router]);

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

  if (!company) {
    return (
      <div className="login-wrap"><div className="login-card">
        <h1>No company access</h1>
        <p className="sub">Your account is not assigned to any company yet. Ask an administrator to add you, then sign in again.</p>
        <button className="btn" onClick={signOut}>Sign out</button>
      </div></div>
    );
  }

  const current = activeHref(pathname);
  const currentLabel = ALL.find((i) => i.href === current)?.label ?? 'Portal';
  const initials = profile.full_name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || 'U';

  return (
    <>
      <div className="mobile-bar no-print">
        <button className="menu-btn" aria-label="Open menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>☰</button>
        <div className="mobile-title">{company.name}</div>
      </div>
      {navOpen && <div className="nav-backdrop no-print" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar no-print${navOpen ? ' open' : ''}`}>
        <button className="nav-close" aria-label="Close menu" onClick={() => setNavOpen(false)}>×</button>
        <div className="brand">
          {companies.length > 1 && (
            <Link href="/adminconsole/overview" className={`nav-item nav-top${pathname === '/adminconsole/overview' ? ' active' : ''}`}>
              <span className="nav-icon">◈</span>All Companies
            </Link>
          )}
          <div className="brand-subtitle">Administration Portal</div>
          {companies.length > 1 && (
            <Select className="company-switch" aria-label="Switch company" value={company.id} onChange={(e) => switchCompany(e.target.value)}>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
        </div>

        {NAV.map((g) => {
          const items = g.items.filter((i) => !i.roles || i.roles.includes(profile.role));
          if (!items.length) return null;
          if (items.length === 1) {
            const i = items[0];
            return (
              <Link key={g.label} href={i.href} className={`nav-item nav-top${current === i.href ? ' active' : ''}`}>
                <span className="nav-icon">{i.icon}</span>{i.label}
              </Link>
            );
          }
          const hasActive = items.some((i) => i.href === current);
          const open = g.label in openGroups ? openGroups[g.label] : hasActive;
          return (
            <div key={g.label}>
              <button type="button" className={`nav-group${hasActive ? ' has-active' : ''}`} aria-expanded={open}
                onClick={() => setOpenGroups((o) => ({ ...o, [g.label]: !open }))}>
                <span className="nav-icon">{g.icon}</span>
                <span className="nav-group-label">{g.label}</span>
                <span className={`nav-chevron${open ? ' open' : ''}`}>›</span>
              </button>
              {open && (
                <div className="nav-sub">
                  {items.map((i) => (
                    <Link key={i.href} href={i.href} className={`nav-sub-item${current === i.href ? ' active' : ''}`}>
                      {i.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="nav-label">Coming later</div>
        <div className="nav-item disabled"><span className="nav-icon">▧</span>Invoices<span className="coming-soon">SOON</span></div>

        <div className="sidebar-footer">
          <div className="user">
            <Link href="/adminconsole/profile" className="user-link" title="My profile">
              <div className="avatar">{initials}</div>
              <div>
                <div className="user-name">{profile.full_name}</div>
                <div className="user-role">{ROLE_LABEL[profile.role]}</div>
              </div>
            </Link>
            <button className="signout" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar no-print">
          <div className="breadcrumb">{company.name} &nbsp;/&nbsp; <strong>{currentLabel}</strong></div>
          <div className="date">{fmtLongDate(new Date())}</div>
        </header>
        <div className="content">{children}</div>
      </main>
    </>
  );
}
