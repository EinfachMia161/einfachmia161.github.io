# MTF Nu-7 "Hammer Down" Database

Concept for moving the MTF Nu-7 roster from a 30-tab Google Sheet into a proper database with a website for editing it.

**Concept page:** https://einfachmia161.github.io/
**Roster test site:** https://einfachmia161.github.io/roster/ (live Supabase database with the full sheet import; anyone with the link can edit)

## What's on the page

- **Inventory** – what each of the 30 sheet tabs contains and where it goes (table, calculated view, web form, or dropped)
- **Database diagram** – entity-relationship diagrams for the core model, the logs, and organisation & honours
- **Promotion board demo** – clickable mock-up of the promotion requirements, with manual ticks and automatic checks (activity, cooldown)
- **Calculated values** – strikes, hours, status, cooldown and overview numbers worked out by the database instead of typed by hand
- **Website plan** – pages, roles (guest, member, NCO, officer, RegCom) and the recommended stack (Supabase + SvelteKit/Next.js)
- **Data problems** found in the current sheet
- **Migration** – four steps from sheet to website
- **SQL schema** for PostgreSQL / Supabase

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The concept page (self-contained; loads fonts from Google Fonts and Mermaid from jsDelivr) |
| `Nu-7 Database.html` | Redirect to the page, so older links keep working |
| `roster/index.html` | Roster test site: roster, member files, promotion board, add member, blacklist, change log |
| `database/` | Schema, access rules, sheet importer, deploy and test scripts ([details](database/README.md)) |

## Updating

Replace `index.html` with the new version and commit. GitHub Pages republishes automatically within a minute or two.
