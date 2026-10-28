# Helper functions for build_data.Rmd (sourced in STEP 0).
# Requires: dplyr, tidyr, purrr, stringr, readr, jsonlite, sf, tidycensus, tigris

# ---- Catalog ---------------------------------------------------------------

# Rows labeled "Worked at home" (to 2018) or "Worked from home" (2019+)
wfh_regex <- "^worked (at|from) home$"

# ACS 1-year "Means of transportation to work by X" tables; each feeds one dimension.
# Race tables carry no subgroups, so their group comes from the table itself.
table_catalog <- tibble::tribble(
  ~table,    ~dim,         ~fixed_group,
  "B08006",  "sex",        NA,
  "B08101",  "age",        NA,
  "B08105H", "race",       "White alone, not Hispanic or Latino",
  "B08105I", "race",       "Hispanic or Latino",
  "B08105B", "race",       "Black or African American alone",
  "B08105D", "race",       "Asian alone",
  "B08105C", "race",       "American Indian and Alaska Native alone",
  "B08105E", "race",       "Native Hawaiian and Other Pacific Islander alone",
  "B08105F", "race",       "Some other race alone",
  "B08105G", "race",       "Two or more races",
  "B08105A", "race",       "White alone (incl. Hispanic)",
  "B08119",  "earnings",   NA,
  "B08124",  "occupation", NA,
  "B08126",  "industry",   NA
)

dim_catalog <- tibble::tribble(
  ~id,          ~label,                     ~note,
  "all",        "All workers",              "",
  "sex",        "Sex",                      "",
  "age",        "Age",                      "",
  "race",       "Race / ethnicity",         "Race groups other than 'White alone, not Hispanic' include Hispanic workers of that race.",
  "earnings",   "Earnings",                 "Earnings bins are in each survey year's dollars (not inflation adjusted across years), so the same bin covers lower real earnings in later years.",
  "occupation", "Occupation",               "",
  "industry",   "Industry",                 ""
)

level_catalog <- tibble::tribble(
  ~id,      ~geography, ~label,
  "us",     "us",       "United States",
  "state",  "state",    "States",
  "metro",  "cbsa",     "Metro areas",
  "place",  "place",    "Cities (places 65k+)"
)

# ---- STEP 1: year availability --------------------------------------------

# TRUE if the Census API serves the ACS 1-year tables for `year`.
# 2020 standard 1-year estimates were never released (pandemic data collection).
acs1_available <- function(year) {
  if (year == 2020) return(FALSE)
  url <- sprintf("https://api.census.gov/data/%d/acs/acs1/groups/B08006.json", year)
  res <- tryCatch(httr::GET(url, httr::timeout(30)), error = function(e) NULL)
  !is.null(res) && httr::status_code(res) == 200
}

# ---- STEP 2: variable selection and fetch ----------------------------------

# From load_variables() output, keep the WFH numerator and worker denominator
# for every group, matching on labels so code shifts across years don't matter.
parse_wfh_vars <- function(vars) {
  drop_parts <- c("Estimate", "Total", "")

  v <- vars %>%
    transmute(name, label, table = str_extract(name, "^[A-Z0-9]+(?=_)")) %>%
    inner_join(table_catalog, by = "table") %>%
    mutate(
      parts  = map(str_split(str_remove_all(label, ":"), "!!"),
                   ~ { p <- str_squish(.x); p[!p %in% drop_parts] }),
      is_wfh = map_lgl(parts, ~ any(str_detect(str_to_lower(.x), wfh_regex))),
      grp    = map_chr(parts, ~ paste(.x[!str_detect(str_to_lower(.x), wfh_regex)],
                                      collapse = " | "))
    )

  num <- filter(v, is_wfh)
  den <- v %>% filter(!is_wfh) %>% semi_join(num, by = c("table", "grp"))

  out <- bind_rows(mutate(num, role = "wfh"), mutate(den, role = "workers")) %>%
    mutate(
      dim = if_else(table == "B08006" & grp == "", "all", dim),
      group_label = case_when(
        dim == "all"          ~ "All workers",
        !is.na(fixed_group)   ~ fixed_group,
        TRUE                  ~ grp
      ),
      var_num = as.integer(str_extract(name, "\\d+$"))
    ) %>%
    # table totals in B081xx duplicate "all"; keep only real subgroups
    filter(!(grp == "" & is.na(fixed_group) & dim != "all")) %>%
    mutate(group_key = group_key(group_label)) %>%
    select(name, table, dim, group_key, group_label, role, var_num)

  dupes <- count(out, dim, group_key, role) %>% filter(n > 1)
  if (nrow(dupes) > 0) stop("Ambiguous WFH variables: ", paste(dupes$group_key, collapse = ", "))
  unpaired <- count(out, dim, group_key) %>% filter(n != 2)
  if (nrow(unpaired) > 0) stop("Unpaired WFH variables: ", paste(unpaired$group_key, collapse = ", "))
  out
}

# Stable id for a group label (survives minor punctuation changes across years)
group_key <- function(x) {
  x %>% str_to_lower() %>% str_replace_all("[^a-z0-9]+", "_") %>% str_remove_all("^_|_$")
}

# Pull `vars` for one geography level and year. Nationwide place pulls fall back
# to state-by-state if the API refuses them.
fetch_level <- function(level, vars, year) {
  geo <- level_catalog$geography[level_catalog$id == level]
  pull <- function(state = NULL) {
    suppressMessages(get_acs(geography = geo, variables = vars, year = year,
                             survey = "acs1", state = state, cache_table = TRUE))
  }
  out <- tryCatch(pull(), error = function(e) { message("  ", level, ": ", conditionMessage(e)); NULL })
  if (is.null(out) && level == "place") {
    out <- map_dfr(c(state.abb, "DC", "PR"), ~ tryCatch(pull(.x), error = function(e) NULL))
  }
  if (is.null(out) || nrow(out) == 0) stop("No data returned for ", level, " ", year)
  if (level == "metro") out <- filter(out, str_detect(NAME, "Metro Area"))
  out %>% transmute(year = as.integer(year), level, GEOID, NAME, variable, estimate, moe)
}

# ---- STEP 3: shares and margins of error -----------------------------------

# MOE of a proportion (Census formula), falling back to the ratio formula
# when the term under the root is negative.
moe_prop_safe <- function(num, den, moe_num, moe_den) {
  p <- num / den
  x <- moe_num^2 - p^2 * moe_den^2
  if_else(x < 0, sqrt(moe_num^2 + p^2 * moe_den^2), sqrt(pmax(x, 0))) / den
}

# Long table: one row per year x level x geo x dim x group, with WFH share (%)
# and its 90% MOE. Special codes (negative values) become NA; an NA MOE
# (insufficient sample) yields an NA share MOE so the change is never called
# significant.
build_shares <- function(raw, wfh_vars) {
  raw %>%
    mutate(estimate = if_else(estimate < 0, NA_real_, estimate),
           moe      = if_else(moe < 0, NA_real_, moe)) %>%
    inner_join(wfh_vars %>% select(year, name, dim, group_key, role),
               by = c("year", "variable" = "name")) %>%
    select(year, level, GEOID, dim, group_key, role, estimate, moe) %>%
    pivot_wider(names_from = role, values_from = c(estimate, moe)) %>%
    mutate(
      share     = if_else(estimate_workers > 0, 100 * estimate_wfh / estimate_workers, NA_real_),
      share_moe = 100 * moe_prop_safe(estimate_wfh, estimate_workers, moe_wfh, moe_workers),
      share_moe = if_else(is.na(share), NA_real_, share_moe)
    )
}

# ---- STEP 4: export --------------------------------------------------------

# One JSON per level x dim: {years, groups, data: {GEOID: {w, s, m}}}, where
# w = workers, s = WFH share (%), m = 90% MOE of s; each a groups x years matrix.
write_dim_file <- function(shares, lvl, d, groups, years, path) {
  s <- filter(shares, level == lvl, dim == d)
  if (nrow(s) == 0) return(invisible(NULL))

  grid <- expand_grid(GEOID = sort(unique(s$GEOID)), group_key = groups, year = years) %>%
    left_join(s, by = c("GEOID", "group_key", "year")) %>%
    arrange(GEOID, match(group_key, groups), year)

  ng <- length(groups); ny <- length(years)
  as_mat <- function(x) matrix(x, nrow = ng, ncol = ny, byrow = TRUE)
  data <- split(grid, grid$GEOID) %>%
    map(~ list(w = as_mat(round(.x$estimate_workers)),
               s = as_mat(round(.x$share, 1)),
               m = as_mat(round(.x$share_moe, 1))))

  write_json(list(level = lvl, dim = d, years = I(years), groups = I(groups), data = data),
             path, na = "null", digits = NA, auto_unbox = TRUE)
}

# Display name: latest NAME per GEOID, without the " Metro Area" suffix
geo_index <- function(raw, lvl) {
  raw %>%
    filter(level == lvl) %>%
    group_by(GEOID) %>% slice_max(year, n = 1, with_ties = FALSE) %>% ungroup() %>%
    transmute(id = GEOID, name = str_remove(NAME, " Metro Area$"), last_year = year)
}

# Cartographic boundaries for the newest vintage tigris can fetch
fetch_shapes <- function(fun, years, ...) {
  for (y in sort(years, decreasing = TRUE)) {
    shp <- tryCatch(suppressMessages(fun(cb = TRUE, year = y, ...)), error = function(e) NULL)
    if (!is.null(shp)) return(list(shp = shp, year = y))
  }
  stop("No boundary vintage available")
}

write_geojson <- function(shp, path) {
  shp %>%
    st_transform(4326) %>%
    select(GEOID) %>%
    st_write(path, driver = "GeoJSON", delete_dsn = TRUE, quiet = TRUE,
             layer_options = "COORDINATE_PRECISION=4")
}

# Place points from the Census Gazetteer (internal point lat/lon)
fetch_place_points <- function(years) {
  for (y in sort(years, decreasing = TRUE)) {
    url <- sprintf("https://www2.census.gov/geo/docs/maps-data/data/gazetteer/%d_Gazetteer/%d_Gaz_place_national.zip", y, y)
    zip <- tempfile(fileext = ".zip")
    ok <- tryCatch(download.file(url, zip, quiet = TRUE, mode = "wb") == 0, error = function(e) FALSE)
    if (!ok) next
    gaz <- read_tsv(unz(zip, unzip(zip, list = TRUE)$Name[1]), col_types = cols(.default = "c"))
    names(gaz) <- str_trim(names(gaz))
    return(gaz %>% transmute(id = GEOID, lat = as.numeric(INTPTLAT), lon = as.numeric(INTPTLONG)))
  }
  stop("No Gazetteer place file available")
}
