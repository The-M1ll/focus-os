-- Usage measured by an integration (currently: the browser extension). Never estimated here.
CREATE TABLE measured_usage(
  day        TEXT NOT NULL CHECK(length(day)=10),
  platform   TEXT NOT NULL CHECK(length(platform) BETWEEN 1 AND 64),
  source     TEXT NOT NULL CHECK(source IN ('browser_extension')),
  seconds    INTEGER NOT NULL CHECK(seconds >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(day, platform, source)
) WITHOUT ROWID;
