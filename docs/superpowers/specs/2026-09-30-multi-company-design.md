# Multi-company support for the HBC portal

Date: 2026-09-30

## Goal
The portal serves two companies with fully separate books and lets users switch between them:
1. Hassan and Bilal Company (existing)
2. Micro Data General Contracting Corporation (new; logo to be uploaded later)

## Decisions
- Fully separate data per company: employees, attendance, payroll, salary slips, quotations, settings, letterhead. Nothing is shared.
- Per-user access: an administrator assigns each user to one or both companies, with a separate role in each.
- Existing data and users become Company 1.
- Approach: one database, `company_id` on every business table, RLS scoped by company membership.

## Database (migration 0007, also folded into setup_all.sql)
- New `companies (id, name, name_ar, slug, created_at)`.
- New `company_members (user_id, company_id, role)`, PK (user_id, company_id). Roles are the existing set.
- Add `company_id not null` (FK) to: employees, attendance, payroll_periods, payroll_entries, salary_slips, quotations, quotation_revisions, quotation_items (as needed), audit_logs.
- `settings`: PK becomes (company_id, key). The `company` row holds per-company name, name_ar, address, phone, email, VAT, CR, logo path.
- Uniqueness becomes per company: payroll month, quotation number, employee code (where applicable).
- Backfill: create both companies; set company_id = Company 1 on all existing rows; copy each `profiles.role` into a Company 1 membership; give Company 2 default settings with its name.
- `profiles` keeps identity only; the global role is superseded by membership roles.

## Security
- Helpers change from "my role" to `role_in(company_id)` and `is_member(company_id)`.
- RLS on every table: rows visible/writable only when the user's role in the row's company permits.
- Payroll, quotation, numbering and reporting functions take a `company_id`, verify membership and role, and only touch that company's rows.
- Storage: signed-slip object paths are prefixed `<company_id>/`; storage policies check membership.
- Only a company's administrators can manage its members.

## UI
- `Providers` holds the current company, its settings, and the user's role in it (stored in localStorage; falls back to the first company the user belongs to).
- Company switcher in `AppShell`; hidden when the user has one company. Switching reloads data.
- All queries filter by current company; all function calls pass it.
- `DocHead`, slips and quotation documents use the current company's details and logo (placeholder for Micro Data until uploaded).
- Settings -> Users & roles: assign users to companies with a role per company.
- `can()` keeps working because it uses the role in the current company.

## Testing
- SQL checks: a user in only Company 1 cannot read or write Company 2 rows; roles differ per company; payroll months and quotation numbers do not collide across companies.
- Manual: dev-server walkthrough of switching, documents, settings and user assignment.

## Risks and rollout
- Changes security rules on live data: delivered as a single SQL migration that Hassan runs in the Supabase SQL Editor; it is not run by Claude.
- Back up / review before running; the backfill is idempotent-safe only on a fresh 0006 database.
