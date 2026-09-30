# Multi-company support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two fully separate companies in the portal (Hassan and Bilal Company, Micro Data General Contracting Corporation) with per-user, per-company roles and an in-app company switcher.

**Architecture:** One database. `companies` + `company_members(user, company, role)`. Every business table gets `company_id not null default current_company()`. The browser sends the chosen company as an `x-company-id` request header (custom `fetch` on the Supabase client); `current_company()` reads it from `request.headers` and returns it only if the caller is a member, so a forged header yields no rows. RLS and security-definer functions scope everything by `current_company()`, so page queries need no per-query company filter. The role used by `has_role()` becomes the caller's role in the current company.

**Tech Stack:** Postgres/Supabase (RLS, plpgsql), Next.js App Router + TypeScript, `@supabase/ssr`. DB tests run on PGlite (`@electric-sql/pglite`, installed with `--no-save`).

**Spec:** `docs/superpowers/specs/2026-09-30-multi-company-design.md`

## Global Constraints

- Company 1 = "Hassan and Bilal Company" (code `HBC`, all existing data); Company 2 = "Micro Data General Contracting Corporation" (code `MDGC`), logo added later.
- Nothing shared between companies; per-user, per-company roles (administrator, payroll, attendance, quotations, viewer).
- Existing users keep their role in Company 1; existing administrators also become administrators of Company 2.
- Service-role key is never used; all access via RLS + security-definer functions.
- The migration is one SQL file the user runs in the Supabase SQL Editor; Claude never runs it against the live database.
- Quotation numbers: `<code>-QT-<year>-<seq>`, sequence per company.
- Storage: legacy signed-slip paths (`salary-slips/<yyyy>/...`) stay valid for Company 1; new paths are `salary-slips/<company_id>/<yyyy>/<mm>/<emp_code>/signed-slip.pdf`.

---

### Task 1: DB test harness (failing first)

**Files:**
- Create: `portal/supabase/tests/run.mjs` (PGlite runner with auth/storage stubs, legacy-data fixture, assertions)

**Interfaces:**
- Produces: `node supabase/tests/run.mjs` exits non-zero on any failed assertion. Runs migrations 0001-0006, inserts legacy single-company data, then applies `0007_multi_company.sql`, then exercises RLS/functions as different users via `set role authenticated` + `request.jwt.claim.sub` + `request.headers`.

- [ ] Step 1: `npm i --no-save @electric-sql/pglite` in `portal/`.
- [ ] Step 2: Write the runner (stubs: `auth.users`, `auth.uid()`, `storage.buckets/objects/foldername`, roles `anon`/`authenticated`, grants).
- [ ] Step 3: Run it; expect failure because `0007_multi_company.sql` does not exist yet.
- [ ] Step 4: Commit.

### Task 2: Migration 0007

**Files:**
- Create: `portal/supabase/migrations/0007_multi_company.sql`
- Modify: `portal/supabase/setup_all.sql` (append 0007), `portal/supabase/seed.sql` (explicit Company 1 id on inserts)

**Interfaces (produced, used by UI and tests):**
- Tables `companies(id, code, name, name_ar)`, `company_members(user_id, company_id, role)`.
- `current_company() -> uuid` (null unless header names a company the caller belongs to), `require_company() -> uuid`, `role_in(uuid) -> app_role`, `has_role_in(uuid, variadic app_role[]) -> boolean`.
- `list_company_team() -> (user_id, full_name, email, role)`; `set_company_member(p_user uuid, p_role app_role)` (null role removes; blocks removing the last administrator).
- All payroll/quotation/attendance functions scoped to `current_company()`.

- [ ] Step 1: Write the migration (tables, backfill with attendance guard trigger disabled during backfill, per-company uniques, helpers, rewritten RLS/functions/storage policies, member functions, Company 2 settings).
- [ ] Step 2: Run `node supabase/tests/run.mjs` until green (isolation, per-company uniqueness, numbering prefix, backfill, last-admin guard, storage path policy).
- [ ] Step 3: Append to `setup_all.sql`, update `seed.sql`.
- [ ] Step 4: Commit.

### Task 3: Client plumbing

**Files:**
- Modify: `portal/src/lib/supabase.ts`, `portal/src/lib/types.ts`, `portal/src/components/Providers.tsx`

**Interfaces:**
- `getCompanyId(): string | null`, `setCompanyId(id: string | null): void` (module state + `localStorage['hbc-company']`), client `fetch` adds `x-company-id`.
- `Company { id; code; name; name_ar }`; `Settings.company.logo?: string`.
- `useApp()` adds `companies: Company[]`, `company: Company | null`, `switchCompany(id: string): void` (sets id and reloads the page). `profile.role` is overridden with the caller's role in the current company so all existing `can(profile.role, ...)` calls keep working.

- [ ] Step 1: Implement. Step 2: `npm run typecheck`. Step 3: Commit.

### Task 4: Shell, documents, branding

**Files:**
- Modify: `portal/src/components/AppShell.tsx`, `portal/src/components/Docs.tsx`, `portal/src/app/adminconsole/(app)/page.tsx`

- [ ] Switcher `<select>` in the sidebar (shown only with 2+ companies); per-company logo (text fallback when no logo); "no company access" screen; breadcrumb and footer use the company name; `DocHead` uses `co.logo`.
- [ ] Typecheck; commit.

### Task 5: Settings (company details, logo, team per company)

**Files:**
- Modify: `portal/src/app/adminconsole/(app)/settings/page.tsx`

- [ ] Settings upsert passes `company_id` and `onConflict: 'company_id,key'`; add Logo path field; replace the profiles-based team table with `list_company_team` / `set_company_member` (including "No access").
- [ ] Typecheck; commit.

### Task 6: Docs, build, final verification

**Files:**
- Modify: `portal/README.md`

- [ ] README: migration 0007 step, Company 2 / logo instructions, multi-company roles.
- [ ] `npm run typecheck`, `npm run build`, rerun DB tests; commit.
