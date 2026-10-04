-- Only the development seed populates this table; production has no mock endpoints.
CREATE TABLE mock_mcp_record (
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  body TEXT NOT NULL CHECK (json_valid(body)),
  PRIMARY KEY (provider, kind, id)
);
