CREATE TABLE IF NOT EXISTS memory_events (
    event_id TEXT PRIMARY KEY,
    user_scope TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    session_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('user','model','tool','screen')),
    content TEXT,
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS memories (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id TEXT NOT NULL UNIQUE,
    user_scope TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('fact','preference','profile','episode','checkpoint')),
    memory_key TEXT,
    content TEXT,
    recorded_at TEXT NOT NULL,
    activated_at TEXT,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    supersedes_id TEXT REFERENCES memories(memory_id),
    revoked_at TEXT,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS memory_scope_key ON memories(user_scope,project_scope,kind,memory_key,seq);
CREATE TABLE IF NOT EXISTS memory_sources (
    memory_id TEXT NOT NULL REFERENCES memories(memory_id),
    event_id TEXT NOT NULL REFERENCES memory_events(event_id),
    PRIMARY KEY(memory_id,event_id)
);
CREATE TABLE IF NOT EXISTS memory_dependencies (
    memory_id TEXT NOT NULL REFERENCES memories(memory_id),
    parent_id TEXT NOT NULL REFERENCES memories(memory_id),
    PRIMARY KEY(memory_id,parent_id)
);
CREATE TABLE IF NOT EXISTS memory_search (
    memory_id TEXT PRIMARY KEY REFERENCES memories(memory_id),
    text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    object_id TEXT NOT NULL,
    user_scope TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_operations (
    operation_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    user_scope TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    object_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL
);
-- C1 context exposure ledger: IDs/versions only, never memory or screen bodies.
CREATE TABLE IF NOT EXISTS memory_context_exposures (
    exposure_id TEXT PRIMARY KEY,
    user_scope TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    session_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    memory_ids TEXT NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN ('prepared','submitted_to_adapter','invalidated')),
    recorded_at TEXT NOT NULL,
    invalidated_at TEXT,
    invalidation_reason TEXT
);
CREATE INDEX IF NOT EXISTS memory_context_exposure_scope
    ON memory_context_exposures(user_scope,project_scope,session_id,generation);
CREATE TABLE IF NOT EXISTS memory_context_states (
    user_scope TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    session_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    status TEXT NOT NULL CHECK(status IN ('clean','needs_refresh','rebuilding','blocked')),
    revision INTEGER NOT NULL,
    invalidation_event_ids TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_scope,project_scope,session_id,generation)
);
-- Additive v1 host settings. Only trusted human commands may change consent.
CREATE TABLE IF NOT EXISTS memory_automation (
    user_scope TEXT NOT NULL,
    project_scope TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    auto_checkpoint INTEGER NOT NULL,
    auto_recall INTEGER NOT NULL,
    retention_days INTEGER NOT NULL,
    consent_event_id TEXT NOT NULL REFERENCES memory_events(event_id),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_scope,project_scope)
);
