CREATE TABLE documents(
  collection TEXT NOT NULL CHECK(length(collection) BETWEEN 1 AND 64),
  id         TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 64),
  json       TEXT NOT NULL CHECK(json_valid(json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(collection, id)
) WITHOUT ROWID;
CREATE INDEX documents_updated ON documents(collection, updated_at);
