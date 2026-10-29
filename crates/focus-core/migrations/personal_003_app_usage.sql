-- Time desktop apps were open on this computer, recorded by the app monitor. Never estimated.
CREATE TABLE app_usage(
  day        TEXT NOT NULL CHECK(length(day)=10),
  app        TEXT NOT NULL CHECK(length(app) BETWEEN 1 AND 56),
  seconds    INTEGER NOT NULL CHECK(seconds >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(day, app)
) WITHOUT ROWID;
