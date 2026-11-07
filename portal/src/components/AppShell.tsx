'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from './Providers';
import { Select } from './ui';
import { isConfigured, supabase } from '@/lib/supabase';
import { fmtLongDate } from '@/lib/format';
import { ACC_SIDE, ATTENDANCE_SIDE, JSA_SIDE, MAIL_SIDE, PAYROLL_SIDE, PETTY_SIDE, QUOTE_SIDE, ROLE_LABEL, STORE_SIDE } from '@/lib/roles';
import type { Role } from '@/lib/types';

function BackIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>;
}

interface NavItem { href: string; label: string; icon: string; roles?: Role[] }
interface NavGroup { label: string; icon: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { label: 'Workspace', icon: '⌂', items: [{ href: '/adminconsole', label: 'Dashboard', icon: '⌂' }] },
  { label: 'Inbox', icon: '✉', items: [{ href: '/adminconsole/mail', label: 'Inbox', icon: '✉', roles: MAIL_SIDE }] },
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
  {
    label: 'JSA Management', icon: '⛑', items: [
      { href: '/adminconsole/jsa', label: 'JSA Dashboard', icon: '⛑', roles: JSA_SIDE },
      { href: '/adminconsole/jsa/knowledge-base', label: 'Safety Knowledge Base', icon: '▤', roles: JSA_SIDE },
      { href: '/adminconsole/jsa/templates', label: 'JSA Templates', icon: '▣', roles: JSA_SIDE },
      { href: '/adminconsole/jsa/settings', label: 'JSA Settings', icon: '⚙', roles: JSA_SIDE },
    ],
  },
  { label: 'Petty Cash', icon: '◉', items: [{ href: '/adminconsole/pettycash', label: 'Petty Cash', icon: '◉', roles: PETTY_SIDE }] },
  {
    label: 'Store', icon: '▦', items: [
      { href: '/adminconsole/store', label: 'Store Inventory', icon: '▦', roles: STORE_SIDE },
    ],
  },
  {
    label: 'Accounting', icon: '∑', items: [
      { href: '/adminconsole/accounting', label: 'Overview', icon: '∑', roles: ACC_SIDE },
      { href: '/adminconsole/accounting/journal', label: 'Journal', icon: '✎', roles: ACC_SIDE },
      { href: '/adminconsole/accounting/accounts', label: 'Chart of Accounts', icon: '▤', roles: ACC_SIDE },
      { href: '/adminconsole/accounting/profit-loss', label: 'Profit & Loss', icon: '↗', roles: ACC_SIDE },
      { href: '/adminconsole/accounting/balance-sheet', label: 'Balance Sheet', icon: '⚖', roles: ACC_SIDE },
    ],
  },
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
  // desktop: the whole navigation sidebar can be hidden to give pages more room (remembered per browser)
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { try { setCollapsed(localStorage.getItem('hbc-sidebar-collapsed') === '1'); } catch { /* storage unavailable */ } }, []);
  const toggleCollapsed = () => setCollapsed((c) => { try { localStorage.setItem('hbc-sidebar-collapsed', c ? '0' : '1'); } catch { /* ignore */ } return !c; });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'b') return;
      if ((e.target as HTMLElement | null)?.closest('input,textarea,select,[contenteditable="true"]')) return;   // Ctrl+B is "bold" while writing
      e.preventDefault();
      toggleCollapsed();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
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

  // unread count for the Inbox menu item (administrators only); refreshed on navigation and every minute
  const [unread, setUnread] = useState(0);
  const mailRole = profile?.role, mailCompany = company?.id;
  useEffect(() => {
    if (!isConfigured || !userId || !mailCompany || !mailRole || !MAIL_SIDE.includes(mailRole)) { setUnread(0); return; }
    let live = true;
    const load = () => {
      supabase().from('mail_messages').select('id', { count: 'exact', head: true }).eq('folder', 'inbox').eq('is_read', false)
        .then(({ count, error }) => { if (live) setUnread(error ? 0 : count ?? 0); });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [userId, mailCompany, mailRole, pathname]);

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
  const atRoot = pathname === '/adminconsole' || pathname === '/adminconsole/overview';
  function goBack() {
    if (window.history.length > 1) router.back();
    else router.push(pathname.split('/').slice(0, -1).join('/') || '/adminconsole');
  }
  const initials = profile.full_name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || 'U';

  return (
    <>
      <div className="mobile-bar no-print">
        <button className="menu-btn" aria-label="Open menu" aria-expanded={navOpen} onClick={() => setNavOpen(true)}>☰</button>
        {!atRoot && <button className="back-btn" aria-label="Go back" onClick={goBack}><BackIcon /></button>}
        <div className="mobile-title">{company.name}</div>
      </div>
      {navOpen && <div className="nav-backdrop no-print" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar no-print${navOpen ? ' open' : ''}${collapsed ? ' collapsed' : ''}`}>
        <button className="nav-close" aria-label="Close menu" onClick={() => setNavOpen(false)}>×</button>
        <div className="brand">
          {companies.length > 1 && (
            <Link href="/adminconsole/overview" title="All Companies" className={`nav-item nav-top${pathname === '/adminconsole/overview' ? ' active' : ''}`}>
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
              <Link key={g.label} href={i.href} title={i.label} className={`nav-item nav-top${current === i.href ? ' active' : ''}`}>
                <span className="nav-icon">{i.icon}</span>{i.label}
                {i.href === '/adminconsole/mail' && unread > 0 && <span className="nav-badge" aria-label={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}
              </Link>
            );
          }
          const hasActive = items.some((i) => i.href === current);
          const open = g.label in openGroups ? openGroups[g.label] : hasActive;
          return (
            <div key={g.label}>
              <button type="button" className={`nav-group${hasActive ? ' has-active' : ''}`} aria-expanded={open} title={g.label}
                onClick={() => { if (collapsed) { setCollapsed(false); try { localStorage.setItem('hbc-sidebar-collapsed', '0'); } catch { /* ignore */ } setOpenGroups((o) => ({ ...o, [g.label]: true })); } else setOpenGroups((o) => ({ ...o, [g.label]: !open })); }}>
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
        <div className="nav-item disabled" title="Invoices (coming soon)"><span className="nav-icon">▧</span>Invoices<span className="coming-soon">SOON</span></div>

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

      <main className={`main${collapsed ? ' wide' : ''}`}>
        <header className="topbar no-print">
          <div className="crumb-row">
            <button className="sidebar-trigger" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={`${collapsed ? 'Expand' : 'Collapse'} sidebar (Ctrl+B)`} aria-expanded={!collapsed} onClick={toggleCollapsed}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>
            </button>
            <span className="crumb-divider" aria-hidden="true" />
            {!atRoot && <button className="back-btn" aria-label="Go back" onClick={goBack}><BackIcon /></button>}
            <div className="breadcrumb">{company.name} &nbsp;/&nbsp; <strong>{currentLabel}</strong></div>
          </div>
          <div className="date">{fmtLongDate(new Date())}</div>
        </header>
        <div className={`content${pathname.startsWith('/adminconsole/mail') ? ' flush' : ''}`}>{children}</div>
      </main>
    </>
  );
}
