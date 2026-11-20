export const initialSchema = `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sessions (
  thread TEXT PRIMARY KEY,
  generation INTEGER DEFAULT 0
);

CREATE TABLE resumes (
  thread TEXT,
  generation INTEGER,
  session TEXT,
  PRIMARY KEY(thread,generation)
);

CREATE TABLE turns (
  id INTEGER PRIMARY KEY,
  dedup TEXT UNIQUE NOT NULL,
  scope TEXT,
  workspace TEXT,
  thread TEXT,
  generation INTEGER,
  route TEXT,
  source TEXT,
  text TEXT,
  has_image INTEGER DEFAULT 0,
  job INTEGER,
  depth INTEGER DEFAULT 0,
  state TEXT DEFAULT 'queued',
  created INTEGER,
  answer TEXT DEFAULT ''
);

CREATE INDEX turns_ready ON turns(state,id);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  op TEXT UNIQUE,
  workspace TEXT,
  scope TEXT,
  thread TEXT,
  generation INTEGER,
  route TEXT,
  title TEXT,
  prompt TEXT,
  worker TEXT,
  parent INTEGER,
  continued INTEGER,
  depth INTEGER,
  eta INTEGER,
  due INTEGER,
  session TEXT,
  state TEXT DEFAULT 'queued',
  created INTEGER,
  started INTEGER,
  ended INTEGER,
  result TEXT DEFAULT '',
  progress TEXT DEFAULT ''
);

CREATE INDEX jobs_ready ON jobs(state,id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  workspace TEXT,
  scope TEXT,
  route TEXT,
  source TEXT,
  direction TEXT,
  text TEXT,
  status TEXT,
  created INTEGER
);

CREATE INDEX messages_scope ON messages(workspace,id);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  seq INTEGER UNIQUE,
  route TEXT,
  kind TEXT,
  text TEXT,
  job INTEGER,
  card TEXT,
  state TEXT DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  next INTEGER,
  first_attempt INTEGER,
  created INTEGER,
  error TEXT
);

CREATE TABLE cards (
  job INTEGER PRIMARY KEY,
  message TEXT
);

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY,
  workspace TEXT,
  scope TEXT,
  route TEXT,
  title TEXT,
  prompt TEXT,
  cron TEXT,
  at INTEGER,
  tz TEXT,
  next INTEGER,
  state TEXT,
  last_turn INTEGER
);

CREATE TABLE hooks (
  id INTEGER PRIMARY KEY,
  workspace TEXT,
  scope TEXT,
  route TEXT,
  title TEXT,
  prompt TEXT,
  secret TEXT UNIQUE,
  enabled INTEGER DEFAULT 1,
  last INTEGER
);

CREATE TABLE hook_events (
  hook INTEGER,
  event TEXT,
  turn INTEGER,
  PRIMARY KEY(hook,event)
);

PRAGMA user_version=1;
`;
