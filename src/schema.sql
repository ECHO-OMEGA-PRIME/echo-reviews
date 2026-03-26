-- Echo Reviews v1.0.0 Schema

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  logo_url TEXT,
  reply_email TEXT,
  auto_respond INTEGER DEFAULT 0,
  review_request_delay_hours INTEGER DEFAULT 24,
  min_rating_for_public INTEGER DEFAULT 3,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  phone TEXT,
  google_place_id TEXT,
  avg_rating REAL DEFAULT 0,
  total_reviews INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  location_id TEXT,
  source TEXT NOT NULL DEFAULT 'direct',
  source_review_id TEXT,
  reviewer_name TEXT NOT NULL,
  reviewer_email TEXT,
  rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
  title TEXT,
  body TEXT,
  sentiment TEXT,
  sentiment_score REAL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','flagged')),
  is_verified INTEGER DEFAULT 0,
  response TEXT,
  responded_at TEXT,
  responded_by TEXT,
  tags TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, source, source_review_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS review_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  location_id TEXT,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','opened','completed','expired')),
  token TEXT UNIQUE,
  sent_at TEXT,
  opened_at TEXT,
  completed_at TEXT,
  expires_at TEXT,
  reminder_count INTEGER DEFAULT 0,
  last_reminder_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT 'How was your experience?',
  body_template TEXT,
  location_id TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
  send_after_hours INTEGER DEFAULT 24,
  reminder_enabled INTEGER DEFAULT 1,
  reminder_after_hours INTEGER DEFAULT 72,
  max_reminders INTEGER DEFAULT 2,
  total_sent INTEGER DEFAULT 0,
  total_completed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Default Widget',
  type TEXT DEFAULT 'carousel' CHECK(type IN ('carousel','grid','list','badge','floating')),
  min_rating INTEGER DEFAULT 4,
  max_display INTEGER DEFAULT 10,
  show_avatars INTEGER DEFAULT 1,
  show_dates INTEGER DEFAULT 1,
  theme TEXT DEFAULT 'light' CHECK(theme IN ('light','dark','auto')),
  accent_color TEXT DEFAULT '#14b8a6',
  custom_css TEXT,
  allowed_domains TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS competitors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  google_place_id TEXT,
  avg_rating REAL DEFAULT 0,
  total_reviews INTEGER DEFAULT 0,
  last_checked_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  location_id TEXT,
  date TEXT NOT NULL,
  reviews_received INTEGER DEFAULT 0,
  avg_rating REAL DEFAULT 0,
  requests_sent INTEGER DEFAULT 0,
  requests_completed INTEGER DEFAULT 0,
  responses_sent INTEGER DEFAULT 0,
  positive INTEGER DEFAULT 0,
  neutral INTEGER DEFAULT 0,
  negative INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, location_id, date)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT DEFAULT '{}',
  actor TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_tenant ON reviews(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(tenant_id, rating);
CREATE INDEX IF NOT EXISTS idx_reviews_source ON reviews(tenant_id, source);
CREATE INDEX IF NOT EXISTS idx_requests_tenant ON review_requests(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_token ON review_requests(token);
CREATE INDEX IF NOT EXISTS idx_analytics_tenant ON analytics_daily(tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_locations_tenant ON locations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id, created_at DESC);
