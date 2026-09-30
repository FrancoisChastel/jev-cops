---
name: safe_skill
description: Formats a list of dates as ISO 8601 strings. Use when the user asks to normalize dates.
---

# Normalize dates

When the user gives you dates in mixed formats, rewrite each one as `YYYY-MM-DD`.

1. Read the dates the user pasted.
2. Rewrite each date in ISO 8601 form.
3. Show the result as a bulleted list, one date per line.

Ask the user when a date is ambiguous (for example `03/04/2026`).
