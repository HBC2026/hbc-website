# HBC Administration Portal

Internal portal for **Hassan and Bilal Company** and **Micro Data General Contracting Corporation** — Payroll and Quotations, with a company switcher. Next.js (App Router, TypeScript) + Supabase (Auth, Postgres, Storage). Served at `hbcgcc.com/adminconsole` (the public website is served at `hbcgcc.com` from the same project).

## 1. Supabase setup

1. Create a Supabase project.
2. In **SQL Editor**, run these files in order:
   `supabase/migrations/0001_schema.sql` → `0002_helpers_audit_rls.sql` → `0003_payroll_functions.sql` → `0004_quotation_functions.sql` → `0005_storage.sql` → `0006_reporting.sql` → `0007_multi_company.sql` → `0008_petty_cash.sql` → `0010_petty_cash_given_by.sql` → `0009_clients.sql`
3. Optional demo data: run `supabase/seed.sql` (12 fictional employees, Aug–Sep 2026 attendance, 8 quotations). Delete later with
   `truncate employees, quotations, payroll_periods restart identity cascade;`
4. **Authentication → Users → Add user** (email + password). The **first** user becomes *Administrator* of every company; later users have **no access** until an administrator gives them a role for a company in **Settings → Users & roles** (roles are per company, so someone can be Payroll in one company and Viewer or No access in the other).
   (Turn off public sign-ups: Authentication → Providers → Email → disable “Allow new users to sign up”.)
5. Storage: `0005_storage.sql` creates the private bucket `signed-salary-slips` (PDF only, 10 MB). Nothing is public; documents open through 60-second signed URLs.

## 2. Run locally

```bash
cd portal
cp .env.example .env.local     # add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
npm install
npm run dev                    # http://localhost:3100/adminconsole
```

Only the public anon key is used. **The service-role key is never used or needed** — all access is enforced by Row Level Security and security-definer functions.

## 3. Deploy (one Vercel project for the website and the portal)

The Vercel project `hbc-website` builds this Next.js app. The static HBC website lives in `public/` (served at `/` via a rewrite in `next.config.mjs`) and the portal at `/adminconsole`.

1. Vercel → project `hbc-website` → Settings → General: **Root Directory = `portal`**, **Framework Preset = Next.js** (clear any custom build/output overrides).
2. Settings → Environment Variables (Production and Preview): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Push to the connected GitHub repo; Vercel auto-deploys. Test a preview deployment before merging to `master`.
4. Supabase → Authentication → URL Configuration: Site URL `https://hbcgcc.com/adminconsole`, and add it to Redirect URLs.

## Companies

Two companies live in one database and are completely separate (employees, attendance, payroll, slips, quotations, settings, audit log). The sidebar switcher appears for users who belong to more than one. The browser sends the chosen company in an `x-company-id` header; the database only honours it for companies the user is a member of (`current_company()`), and row-level security does the rest.

- Company 1: Hassan and Bilal Company (quotation prefix `HBC`). Everything that existed before migration 0007 belongs to it.
- Company 2: Micro Data General Contracting Corporation (prefix `MDGC`). Fill in its address, CR and VAT numbers in **Settings → Company details** while viewing it.
- Logo: copy the image into `portal/public/` (e.g. `md-logo.webp`) and set **Logo file** in Settings to `/md-logo.webp`. Until then the company name is shown instead.
- Upgrading an existing database: run `0007_multi_company.sql` once. Existing users keep their role in Company 1 and existing administrators become administrators of Company 2.
- Database tests (no Supabase needed): `npm i --no-save @electric-sql/pglite && node supabase/tests/run.mjs`

## Business rules (configurable in Settings)

| Rule | Default |
|---|---|
| Hourly rate | basic ÷ 30 ÷ 8 |
| OT amount | OT hours × hourly rate × 1.5 (or a per-employee multiplier, or fixed SAR/hour) |
| Unpaid days | Absent + Unpaid Leave, each deducts basic ÷ 30 |
| Paid days | Present, Annual Leave, Sick Leave, Holiday, Weekly Off |
| Net | basic + allowances + OT + other earnings − absence − other deductions |
| VAT | 15% |

Payroll is calculated in the database (`calculate_payroll`) from attendance — OT is entered once, in attendance.

## Roles

| Role | Can |
|---|---|
| administrator | everything, incl. reopen payroll, settings, roles |
| payroll | employees, calculate/approve payroll, slips, signed uploads |
| attendance | mark attendance |
| quotations | create/revise quotations |
| viewer | read-only |

## Workflow

Attendance → Calculate → Review (validation) → Approve (locks period + attendance, generates slips) → Print slips → Upload signed PDFs → Complete (automatic when every signed slip is uploaded). Reopening requires a reason and is audit-logged; if amounts change on re-approval, affected slips are reset and must be re-signed.

Storage path: `salary-slips/{year}/{month}/{employee_id}/signed-slip.pdf` (stored in `salary_slips.signed_path`).

## Structure

```
supabase/migrations   schema, RLS, payroll & quotation functions, storage, reporting
supabase/seed.sql     demo data
src/lib               supabase client, formatters, roles, types, slip upload helpers
src/components        AppShell (sidebar), ui, Docs (A4 slip / quotation), forms
src/app/adminconsole  login + (app)/ dashboard, employees, attendance, payroll, slips, archive, quotations, audit, settings
public/               static HBC website (index.html, css/, assets/) plus portal logo files
```

Printing: "Print" and "Download PDF" use the browser print dialog with A4 print CSS (choose *Save as PDF* to download).

## Petty cash

**Petty Cash** in the sidebar (administrator / payroll write, viewer read). Give cash to an employee, and they upload receipts against it from a phone; the employee's balance is *cash given − receipts that are not rejected*.

- Employees do not sign in. Open an employee in Petty Cash → **Copy link** and send them `https://hbcgcc.com/pettycash/<token>` (WhatsApp etc.). **New link** revokes the old one.
- The employee page works only through token-checked database functions (`pc_statement`, `pc_add_receipt`, `pc_delete_receipt`) and an insert-only upload folder in the private bucket `petty-cash-receipts`; it can never see another employee.
- **Reject** a receipt (a reason is required) and it stops counting; the employee sees the reason and uploads it again. Approved receipts can't be removed by the employee.
- Run `0008_petty_cash.sql` then `0010_petty_cash_given_by.sql` once. Each cash entry records who gave the money. Existing databases need nothing else.
