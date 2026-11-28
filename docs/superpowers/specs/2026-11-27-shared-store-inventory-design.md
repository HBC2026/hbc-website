# Shared Store Inventory

## Intent
Store Inventory belongs to no company, the same as petty cash (`0032`). One sheet for all companies, whichever company is selected.

## Goals
- Existing items of every company are merged into one sheet. Nothing is deleted. Past signed checks are all listed.
- Access counts the user's role in ANY company: administrator, payroll, attendance edit; quotations, viewer read only.
- Store Inventory sits at the top of the menu next to Petty Cash.
- Existing photos stay where they are and remain visible.

## Non-goals
Other modules stay per company. Photo files are not moved. The audit entry for a save stays in the selected company's audit log.

## Approaches
1. **Remove the company link** (chosen): drop `company_id` from `store_items` and `store_checks`, as petty cash did. Simple, one rule.
2. Keep the company tag and only widen reading: saving and permissions would stay split by company. Rejected.

## Added later the same day: add one item from a phone
- "Add item" form: photo from camera or gallery, name, quantity, location, condition, status, optional purchase date, useful life, warranty.
- Saves at once through `store_add_item`, no signature; recorded in the audit log.
- So an older open sheet cannot delete it, `store_save_all` deletes only the rows listed as removed, and a row deleted elsewhere is not re-created. The signed copy holds only the rows that were on the checker's screen.

## Constraints
- New migration `0044`, run by hand in Supabase, coordinated with the deploy (the old page cannot save after it).
- Storage requests may not carry the company header, so photo access must not depend on it.
