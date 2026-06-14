# OAKKTREEUNII Job Pipeline — Setup (enriched, multi-source)

Free, secure backend for the job-finder widget. Runs entirely on GitHub (no server, no credit card).

```
GitHub Action (every 6 hrs)
   -> pulls from MANY free sources (keys hidden in repo secrets)
        Adzuna (US+CA) · Greenhouse/Lever/Ashby ATS · The Muse · Remotive · USAJobs(optional)
   -> de-dupes, scores by intent, and ENRICHES each job:
        seniority · work mode · sponsorship signal · certs · years of experience
        pay-vs-market · "why it fits" · TL;DR
   -> writes jobs.json  ->  served by GitHub Pages (open CORS)
   -> mirrors rows into your Notion table
        |
        v
Framer embed fetches jobs.json   (no keys in browser, no rate limits, unlimited traffic)
```

Adzuna keys never touch the browser, and visitor traffic never burns your quota — the API is called only ~4 times a day.

---

## Files

| File | What it is |
|---|---|
| `fetch-jobs.js` | Multi-source pull + intent scoring + enrichment + Notion sync (Node, zero deps). |
| `.github/workflows/update-jobs.yml` | The 6-hourly schedule. |
| `jobs.json` | Seed file; the Action overwrites it. |
| `package.json` | Minimal Node metadata. |
| `../oaktreeuni-job-finder.html` | The Framer widget (badges, detail popup, Save/Applied tracker). |

---

## Part A — Repo + secrets (5 min)

1. Create a **new public GitHub repo**, e.g. `oaktree-jobs`.
2. Upload the contents of this `job-pipeline` folder to the repo root (keep `.github/workflows/` intact).
3. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - `ADZUNA_APP_ID` = `eec5d14f`
   - `ADZUNA_APP_KEY` = `4f413c4553e7142129e7ea77aac599a7`
   - *(optional)* `USAJOBS_KEY` + `USAJOBS_EMAIL` — free key from https://developer.usajobs.gov for US government roles with real salaries.
   - *(optional)* `NOTION_TOKEN` + `NOTION_DATABASE_ID` — see Part D.

## Part B — GitHub Pages (2 min)

Repo → **Settings → Pages** → Source **Deploy from a branch**, Branch **main**, Folder **/(root)**. Save.
Your feed will be at `https://YOUR-USERNAME.github.io/oaktree-jobs/jobs.json`.

## Part C — Run + connect the widget (3 min)

1. Repo → **Actions → Update jobs.json → Run workflow**. Wait ~1 min.
2. In `oaktreeuni-job-finder.html` set:
   ```js
   var CONFIG = { JOBS_JSON_URL: "https://YOUR-USERNAME.github.io/oaktree-jobs/jobs.json" };
   ```
3. Paste the HTML into your Framer **Embed**. Done.

---

## Choosing your target companies (the high-value bit)

Direct ATS pulls give you the freshest, richest postings from companies you choose. In `fetch-jobs.js`, edit:

```js
const ATS = {
  greenhouse: ["stripe","databricks","airtable","gitlab"],
  lever:      ["plaid","brex"],
  ashby:      ["ramp","linear"]
};
```

To find a company's slug, open its careers page:
- Greenhouse: `boards.greenhouse.io/<slug>` or `job-boards.greenhouse.io/<slug>`
- Lever: `jobs.lever.co/<slug>`
- Ashby: `jobs.ashbyhq.com/<slug>`

Add as many as you like — these sources are unlimited and free. Pick the companies your mentees actually target.

---

## What the enrichment means (all free, rule-based)

| Field | How it's derived |
|---|---|
| **Seniority** | Junior / Mid / Senior from title + experience cues. |
| **Work mode** | Remote / Hybrid / Onsite from title, description, location. |
| **Sponsorship** | Parsed from the listing: friendly / none / citizens-clearance / not-stated. *A signal to verify, not a guarantee.* |
| **Certs** | CSM, PSM(II/III), CSPO, SAFe, PMP, PMI-ACP, ICP-ACC, PRINCE2 detected in text. |
| **Years of experience** | First "N+ years … experience" found. |
| **Pay vs market** | Listing salary compared to the built-in US/CA market band (only shown when the listing states a real salary). |
| **Why it fits / TL;DR** | Template sentence + top 3 description lines. Swap in an LLM later for sharper output (the hook is in `whyFit()` / `tldr()`). |

The widget exposes these as filters: Region, Seniority, Best-match slider, Remote-only, **Sponsorship-friendly**, and **Saved/Applied only**. Clicking a card opens a detail popup; the **Save** and **Mark applied** buttons remember state in the visitor's own browser (no backend).

---

## Part D — Notion mirror (optional)

Browsable, auditable table. Mirror only — the website never reads Notion.

1. Create an integration at https://www.notion.so/my-integrations → copy the token.
2. Create a database with these **exact** properties:

   | Property | Type | Property | Type |
   |---|---|---|---|
   | `Name` | Title | `Seniority` | Select |
   | `Company` | Text | `Work mode` | Select |
   | `Recruiter` | Text | `Sponsorship` | Select |
   | `Location` | Text | `Experience` | Text |
   | `Country` | Select | `Certs` | Text |
   | `Posted` | Date | `Source` | Select |
   | `Pay` | Text | `Remote` | Checkbox |
   | `Match` | Number | `URL` | URL |
   | `JobID` | Text | | |

3. In the database: **••• → Connections → Add connection →** your integration.
4. Copy the database ID from its URL (32-char chunk before `?`).
5. Add secrets `NOTION_TOKEN` and `NOTION_DATABASE_ID`, then re-run the workflow.

Leave the Notion secrets unset to skip Notion entirely.

---

## Quota math (still well within free)

- **Adzuna:** 8 queries × 2 countries = 16 calls/run × 4 runs/day = **64/day** (free tier ~250/day).
- **Greenhouse / Lever / Ashby / The Muse / Remotive:** free and unlimited.
- **USAJobs:** free key, light usage.

No matter how many visitors hit the site, the API usage is fixed at the numbers above.

---

## Tuning (`fetch-jobs.js`)

- `ATS` — your target companies (above).
- `QUERIES` — Adzuna search terms / intent net.
- `MIN_SCORE_KEEP` — drop weak matches (default 35).
- `PAY_TABLE` — market bands by role / region / seniority.

## Upgrade path

Scoring + enrichment run server-side, so adding **AI** later is a drop-in: call an LLM inside `whyFit()`/`tldr()` (and for smarter sponsorship detection) before writing `jobs.json`. The key stays in GitHub secrets — never exposed to the browser.
