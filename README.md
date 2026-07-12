# Branching Review

A two-branch literature scan for transparent literature-review screening. Given a seed paper, a keyword phrase, and a journal set, the app retrieves:

- **Depth branch** — records citing the seed paper.
- **Breadth branch** — records matching the keyword query.
- **Convergent core** — records found in both branches after de-duplication.

The default seed is:

> Oh, O., Agrawal, M., & Rao, H. R. (2013). *Community intelligence and social media services: A rumor theoretic analysis of tweets during social crises*. MIS Quarterly, 37(2), 407–426. https://doi.org/10.25300/MISQ/2013/37.2.05

## What changed in this multi-source version

The original prototype searched OpenAlex only. This version adds:

- OpenAlex search using the site owner’s Vercel environment key.
- Bring-your-own-key Web of Science search.
- Bring-your-own-key Scopus search.
- Optional manual upload of exported records from WoS, Scopus, or other databases.
- Cross-source merge and de-duplication by DOI, then by title-year-first-author.
- Source provenance in exported CSV files.

## Key privacy/cost design

- The OpenAlex key is stored on Vercel as `OPENALEX_API_KEY`.
- WoS and Scopus keys are pasted by each user and sent only with the current search request.
- WoS and Scopus keys are not stored in the browser, GitHub, Vercel environment variables, or server logs by this app.
- The optional Claude synthesis remains bring-your-own-key and is also request-only.

## Local setup

```bash
npm install
cp .env.example .env
# then edit .env with your OpenAlex key and email
vercel dev
```

The frontend is a Vite React app. Vercel serves the API functions in `api/`.

## Vercel setup

In Vercel, set these environment variables:

```text
OPENALEX_API_KEY=your OpenAlex key
OPENALEX_MAILTO=your email
```

No WoS, Scopus, or Anthropic key is required in Vercel. Users provide those keys only when they run a request.

## Files

```text
api/
  resolve.js       OpenAlex seed and journal lookup
  search.js        OpenAlex + BYO WoS + BYO Scopus + upload merge/de-duplication
  synthesize.js    Optional BYO Anthropic synthesis
src/
  App.jsx          Interface
  presets.js       Journal presets and default seed
  styles.css       Visual style
```

## Practical caveats

This is still a discovery and transparency scaffold, not a replacement for full PRISMA screening.

- OpenAlex works end to end by default.
- Scopus works when the user’s key and institutional access support Scopus Search API. InstToken can be supplied when needed.
- Web of Science Starter supports metadata search, but depth/citing-item workflows may require Web of Science API Expanded or manual export/import. Use the WoS depth-query field or upload WoS depth results manually.
- For the most reproducible PRISMA workflow, export records from WoS and Scopus, upload them, merge, de-duplicate, then screen manually.
