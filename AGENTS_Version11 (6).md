## Patreon Tier Value Scraper - Agent notes

- Purpose: Extract creator tier metadata from public Patreon creator pages and download tier images for downstream value analysis.
- Important: Patreon UI and login flow change often. Test the login path and extraction selectors on a few creators and adapt selectors in src/main.js.
- Auth: The scaffold includes a credentials login placeholder. For production, prefer cookie-based session reuse or OAuth (if Patreon provides) and store secrets in environment variables.
- Images: Downloaded to the default Key-Value store under images/<creatorSlug>/. Ensure you have the right to store/process creators' images.
- Next improvements:
  - Add robust login flow with 2FA handling,
  - Add dedupe of tiers & creators in Key-Value store,
  - Compute a value score (benefitCount / price) and rank creators,
  - Add webhook for notable high-value tiers,
  - Add image-based analysis (color palette, visual similarity) for trend detection.