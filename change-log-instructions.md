Given a change/diff, decide if it’s changelog-worthy and output a markdown snippet + a Conventional Commit line.

ADD if ANY apply: feature/UI change; bug fix; perf impact; DevOps/Build change; meaningful refactor; user/contrib docs.
SKIP (housekeeping): comments/whitespace/renames only; WIP/experiments; auto bumps w/ no behavior change.

Date: today in Asia/Riyadh, format YYYY-MM-DD.
Placement: append under today’s date if present; else create it. Make sure when you create a date record, it should be in descending order, the change logs should should be added above the previous date's changelogs, not below.
Sections (pick what applies): ✨ Features | 🐛 Fixes | ⚡ Performance | 💅 Styling and UI Improvements | 🔧 DevOps / Build | 🧹 Refactors | 📚 Docs

OUTPUT EXACTLY:

## 🗓️ **YYYY-MM-DD**

---

### <SECTION NAME>

---

> ### <Short title>
>
> - **What changed:** <one line>.
> - **Why:** <brief impact>.
> - **Files:**
>   - `path/to/fileA`
>   - _(Or summarize: “~N files in `app/kyc/_`”)\*

If housekeeping only, reply: **No changelog entry needed — housekeeping only.**
