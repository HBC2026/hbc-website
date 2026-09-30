# Replace the Current HBC Website

You are working inside the existing production website repository for HBC, a Saudi Arabian construction and industrial contracting company.

The attached ZIP contains an approved HTML design and its final assets. Your task is to replace the visual design and public-facing content of the current website with this approved version while preserving any necessary production infrastructure.

## Source of truth

Use the files under `site/` as the visual and content source of truth:

- `site/index.html`
- `site/styles.css`
- `site/corporate.css`
- `site/vision.css`
- `site/script.js`
- `site/assets/`

Open `site/index.html` first and run it locally to understand the approved experience before modifying the existing project.

## Main objective

Rebuild the current website so it matches the supplied HTML sample as closely as possible:

- Same overall layout, section order, spacing and visual hierarchy
- Same graphite, royal-blue, white and restrained gold palette
- Same bilingual English/Arabic behavior
- Same corporate construction tone
- Same responsive desktop and mobile experience
- Same approved text unless existing verified company information should replace a placeholder

Do not redesign it into a different template. Do not simplify the approved page or replace it with a generic construction theme.

## Preserve the existing website’s technical requirements

Before changing files, inspect the current repository and identify:

- Framework, package manager and build commands
- Existing routes and reusable components
- Hosting/deployment configuration
- Working forms, APIs, analytics, SEO and structured data
- Environment variables and integrations

Implement the approved design using the existing framework. Preserve working backend integrations, analytics, domain configuration, SEO value and deployment settings unless they conflict with this request. Do not expose, delete or hard-code secrets.

If the current site is a component framework such as Next.js, React or Vue, convert the supplied static HTML into maintainable components rather than embedding the entire page in one raw HTML string.

## Asset rules

Use the supplied files directly.

### HBC logo

- The official source is `brand-assets/LOGO SYMBOL-01.svg`.
- Use this exact SVG for the website logo.
- Do not redraw, trace, approximate, recolor, regenerate or convert it into text.
- Do not add a separate made-up HBC wordmark beside it.
- Maintain its original aspect ratio and clear space.

### Vision 2030 emblem

- The approved source is `brand-assets/61f72835-ae75-4d99-a241-0fdd455d040b.png`.
- Use this exact emblem in the Vision 2030 section.
- Do not redraw, recolor, crop, regenerate or alter it.
- Do not describe its presence as evidence of certification, partnership or government endorsement.

### Photography

Use the approved images in `site/assets/`. Preserve their aspect ratios and use responsive image handling. The team images intentionally show people with clearly different ages, facial features, nationalities, body types and roles. Do not replace them with images containing cloned faces or repeated identities.

## Required page content

Keep these approved sections:

1. Sticky header with original HBC symbol
2. Saudi industrial construction hero
3. Four-part capability bar
4. Corporate company overview
5. Civil, industrial, MEP and HSE services
6. Vision 2030 section with the supplied official emblem and three official themes
7. Assess → Plan → Execute → Verify delivery process
8. Selected project sectors
9. HSE governance section with toolbox-talk imagery
10. Contact/project-inquiry call to action
11. Corporate footer

## Bilingual requirements

- Preserve English LTR and Arabic RTL.
- The language switch must update every visible label and persist the user’s preference.
- Use professional Arabic, not literal machine translation.
- Verify spacing, alignment, icons and navigation independently in RTL.

## Do not invent facts

Do not invent:

- Project counts, years of experience or safety-hour statistics
- Client names or logos
- Certifications
- Government approvals
- Office locations
- Phone numbers or email addresses
- Project names, dates or contract values

When verified current-site information exists, use it. Otherwise retain clearly marked placeholders and list them in your handover.

## Functional and quality requirements

- Responsive at mobile, tablet, laptop and large desktop sizes
- Accessible semantic structure, keyboard navigation and visible focus states
- Optimized responsive images and no layout shift
- Working mobile menu and bilingual toggle
- Existing inquiry form kept functional, or clearly identify any missing form endpoint
- No broken links, missing assets or console errors
- Respect `prefers-reduced-motion`
- Preserve or improve existing metadata, sitemap, robots configuration and structured data

## Execution sequence

1. Inspect the current repository and run its existing build before editing.
2. Review the supplied approved HTML and assets.
3. Create a short mapping from the sample sections to the existing project files/components.
4. Implement the replacement.
5. Run formatting, type-checking and production build commands supported by the project.
6. Test desktop/mobile layouts, navigation, English/Arabic switching, RTL, forms and links.
7. Compare the finished site against the supplied HTML and correct visible differences.
8. Summarize changed files, preserved integrations, validation results and any company details still required.

Proceed with implementation. Do not stop after presenting a plan, mockup or code sample.

