# Work-from-home map (ACS 1-year, 2015 onward)

An interactive map of the share of workers who worked from home, by state, metro area, and city, with the change between any two years (default 2019 to the latest release) for groups defined by sex, age, race/ethnicity, earnings, occupation, and industry. Clicking a region shows its trend since 2015 and a group-by-group comparison with margins of error.

The data come from the Census API through `tidycensus`. A GitHub Action checks the API daily and rebuilds the site when a new ACS 1-year release appears, so the 2025 data will be added on the first run after the API serves it.

## Setup (once)

1. Create a GitHub repository and push this folder to `main`.
2. Get a free Census API key at <https://api.census.gov/data/key_signup.html> and add it as a repository secret named `CENSUS_API_KEY` (Settings → Secrets and variables → Actions).
3. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
4. Actions → "Update ACS data and site" → **Run workflow**. The first run pulls every year (roughly 10 to 15 minutes); later runs pull only new years. The map is then at `https://<user>.github.io/<repo>/`.

To build locally instead, set `CENSUS_API_KEY` and run from the repository root:

```r
rmarkdown::render("R/build_data.Rmd", knit_root_dir = getwd(),
                  output_dir = "docs", output_file = "build-report.html")
```

then serve `docs/` (for example `servr::httd("docs")`); opening `index.html` directly from disk will not load the JSON.

## How it works

| Path | Role |
|---|---|
| `R/build_data.Rmd` | STEP 0 setup; STEP 1 find uncached years on the API; STEP 2 pull them; STEP 3 WFH shares and MOEs; STEP 4 export JSON and boundaries |
| `R/functions.R` | Table catalog, label parsing, fetch, MOE, export helpers |
| `data-raw/` | Per-year cache of the raw pulls (committed, so reruns are incremental) |
| `docs/` | The static site (Leaflet + D3) and its `data/` folder |
| `docs/build-report.html` | Output of the last build, including a national sanity check by year |

Variables are matched by label ("Worked at home" through 2018, "Worked from home" from 2019) rather than by variable code, so code shifts between years do not break the pull. Each WFH count is paired with the matching total-workers row for the same group.

| Characteristic | ACS table |
|---|---|
| All workers, sex | B08006 |
| Age | B08101 |
| Race / ethnicity | B08105A to B08105I |
| Earnings | B08119 |
| Occupation | B08124 |
| Industry | B08126 |

To add a characteristic (for example tenure, B08137, or vehicles available, B08141), add a row to `table_catalog` and `dim_catalog` in `R/functions.R`, then run the workflow with "force refresh".

## Caveats

- **No 2020.** The Census Bureau did not release standard 1-year estimates for 2020; charts bridge the gap with a dotted segment.
- **Coverage.** 1-year estimates exist only for areas with 65,000+ residents, and many small subgroups (for example, a small race group in a mid-sized city) are suppressed or very noisy. Regions without an estimate are drawn as "No estimate".
- **Significance.** A change is flagged significant when it exceeds √(MOE₁² + MOE₂²) at the 90% level. This treats the two years as independent samples, which is the Census Bureau's standard approximation. Missing MOEs (insufficient sample) are never flagged significant.
- **Measure.** ACS asks how a person usually got to work last week. Hybrid workers who commuted most days are counted as commuters, so the ACS figure is closer to "fully or mostly remote" than to any remote work.
- **Earnings** bins are in each survey year's dollars, so a fixed bin covers lower real earnings in later years.
- **Metro definitions.** Metro areas use the CBSA codes of each survey year. Recent ACS releases adopted the 2023 OMB delineations (I have not verified which survey year first used them), so a metro whose code changed shows as two partial series; the map draws boundaries from the newest vintage only.
- **Race.** Race groups other than "White alone, not Hispanic" include Hispanic workers of that race.
