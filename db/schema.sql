-- =============================================================================
-- Handoff - Event-sourced task transfer system
-- PostgreSQL schema (target: PostgreSQL 13+)
--
-- Conventions:
--   * snake_case identifiers (unquoted, folded to lowercase by Postgres).
--     The TypeScript layer in packages/domain/src/types.ts uses camelCase;
--     map at the repository boundary (e.g. knex/pg-promise column mapping).
--   * All timestamps are TIMESTAMP WITH TIME ZONE, stored in UTC.
--   * Lifecycle/type columns are VARCHAR guarded by CHECK constraints, so the
--     allowed values stay in sync with the TS enums without ALTER TYPE churn.
-- =============================================================================

BEGIN;

-- gen_random_uuid() is built in from PG13; the extension keeps PG12 working.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE users (
    id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email        VARCHAR(320) NOT NULL UNIQUE,
    display_name VARCHAR(120) NOT NULL,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT users_email_not_blank CHECK (length(btrim(email)) > 0),
    CONSTRAINT users_display_name_not_blank CHECK (length(btrim(display_name)) > 0)
);

-- Case-insensitive uniqueness on top of the exact-match UNIQUE above.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_created_at_idx ON users (created_at DESC);

COMMENT ON TABLE users IS 'People who own, transfer, and comment on tasks.';

-- -----------------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------------
CREATE TABLE projects (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID         NOT NULL,
    name       VARCHAR(200) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT projects_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
    CONSTRAINT projects_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX projects_user_id_idx    ON projects (user_id);
CREATE INDEX projects_created_at_idx ON projects (created_at DESC);
-- Owner's project list, newest first - the common dashboard query.
CREATE INDEX projects_user_id_created_at_idx ON projects (user_id, created_at DESC);

COMMENT ON COLUMN projects.user_id IS 'Owning user. Projects are never orphaned; delete is RESTRICTed.';

-- -----------------------------------------------------------------------------
-- tasks
--
-- Current-state projection of the task_events stream. `version` is the
-- optimistic-concurrency token: writers issue
--     UPDATE tasks SET ..., version = version + 1
--      WHERE id = $1 AND version = $2
-- and treat a zero row count as a concurrent-modification conflict.
-- -----------------------------------------------------------------------------
CREATE TABLE tasks (
    id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID         NOT NULL,
    title      VARCHAR(500) NOT NULL,
    status     VARCHAR(32)  NOT NULL DEFAULT 'BACKLOG',
    owner_id   UUID,
    version    INTEGER      NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT tasks_project_id_fkey
        FOREIGN KEY (project_id) REFERENCES projects (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT tasks_owner_id_fkey
        FOREIGN KEY (owner_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT tasks_title_not_blank CHECK (length(btrim(title)) > 0),
    CONSTRAINT tasks_version_non_negative CHECK (version >= 0),
    CONSTRAINT tasks_status_valid CHECK (status IN (
        'BACKLOG',
        'ASSIGNED',
        'IN_PROGRESS',
        'BLOCKED',
        'COMPLETED',
        'TRANSFERRED'
    )),
    -- BACKLOG is the only state that may be unowned; every other state implies
    -- a responsible user.
    CONSTRAINT tasks_owner_required_when_active CHECK (
        status = 'BACKLOG' OR owner_id IS NOT NULL
    )
);

CREATE INDEX tasks_project_id_idx ON tasks (project_id);
CREATE INDEX tasks_owner_id_idx   ON tasks (owner_id);
CREATE INDEX tasks_status_idx     ON tasks (status);
CREATE INDEX tasks_created_at_idx ON tasks (created_at DESC);
-- Board queries: a project's tasks bucketed by column, newest first.
CREATE INDEX tasks_project_id_status_created_at_idx
    ON tasks (project_id, status, created_at DESC);
-- "My open work" - skips finished tasks entirely.
CREATE INDEX tasks_owner_id_open_idx
    ON tasks (owner_id, created_at DESC)
    WHERE status NOT IN ('COMPLETED', 'TRANSFERRED');

COMMENT ON TABLE tasks IS 'Current-state projection rebuilt from task_events.';
COMMENT ON COLUMN tasks.version IS 'Optimistic-concurrency token; incremented on every state mutation.';

-- -----------------------------------------------------------------------------
-- task_events - APPEND ONLY
--
-- The system of record. `sequence` is a per-task counter starting at 1 and
-- advancing by exactly 1; UNIQUE (task_id, sequence) makes concurrent appends
-- at the same position fail loudly instead of interleaving silently.
-- UPDATE and DELETE are rejected by the triggers below.
-- -----------------------------------------------------------------------------
CREATE TABLE task_events (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    UUID        NOT NULL,
    type       VARCHAR(64) NOT NULL,
    actor_id   UUID,
    payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    sequence   INTEGER     NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT task_events_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES tasks (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    -- Deleted actors become NULL ("removed user") rather than erasing history.
    CONSTRAINT task_events_actor_id_fkey
        FOREIGN KEY (actor_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT task_events_task_id_sequence_key UNIQUE (task_id, sequence),
    CONSTRAINT task_events_sequence_positive CHECK (sequence >= 1),
    CONSTRAINT task_events_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT task_events_type_valid CHECK (type IN (
        'TaskCreated',
        'TaskAssigned',
        'TaskStarted',
        'TaskUnassigned',
        'TaskBlocked',
        'TaskTransferred',
        'TaskCompleted',
        'TaskUnblocked',
        'TaskReopened'
    ))
);

-- Stream replay: read one task's events in order.
CREATE INDEX task_events_task_id_sequence_idx ON task_events (task_id, sequence);
CREATE INDEX task_events_task_id_idx          ON task_events (task_id);
CREATE INDEX task_events_actor_id_idx         ON task_events (actor_id);
CREATE INDEX task_events_created_at_idx       ON task_events (created_at DESC);
CREATE INDEX task_events_type_created_at_idx  ON task_events (type, created_at DESC);
-- Brief generation filters on payload keys; GIN keeps containment cheap.
CREATE INDEX task_events_payload_gin_idx      ON task_events USING GIN (payload jsonb_path_ops);

CREATE OR REPLACE FUNCTION task_events_reject_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
    RAISE EXCEPTION
        'task_events is append-only: UPDATE is not permitted (task_id=%, sequence=%)',
        OLD.task_id, OLD.sequence
        USING ERRCODE = 'restrict_violation';
END;
$fn$;

CREATE TRIGGER task_events_no_update
    BEFORE UPDATE ON task_events
    FOR EACH ROW EXECUTE FUNCTION task_events_reject_update();

-- Row-level DELETE is blocked, but the FK cascade from tasks must still work:
-- dropping a task drops its stream. The guard therefore fires only while the
-- parent task still exists.
CREATE OR REPLACE FUNCTION task_events_reject_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
    IF EXISTS (SELECT 1 FROM tasks WHERE id = OLD.task_id) THEN
        RAISE EXCEPTION
            'task_events is append-only: DELETE is not permitted (task_id=%, sequence=%)',
            OLD.task_id, OLD.sequence
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
END;
$fn$;

CREATE TRIGGER task_events_no_delete
    BEFORE DELETE ON task_events
    FOR EACH ROW EXECUTE FUNCTION task_events_reject_delete();

COMMENT ON TABLE task_events IS 'Append-only event stream; the authoritative task history.';
COMMENT ON COLUMN task_events.sequence IS 'Per-task position, 1-based and gapless. UNIQUE with task_id.';

-- -----------------------------------------------------------------------------
-- handoffs
-- -----------------------------------------------------------------------------
CREATE TABLE handoffs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id      UUID NOT NULL,
    from_user_id UUID,
    to_user_id   UUID NOT NULL,
    reason       TEXT,
    status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    resolution_note TEXT,
    resolved_at     TIMESTAMP WITH TIME ZONE,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT handoffs_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES tasks (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT handoffs_from_user_id_fkey
        FOREIGN KEY (from_user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    CONSTRAINT handoffs_to_user_id_fkey
        FOREIGN KEY (to_user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE RESTRICT,

    CONSTRAINT handoffs_distinct_parties CHECK (
        from_user_id IS NULL OR from_user_id <> to_user_id
    ),
    CONSTRAINT handoffs_status_valid CHECK (status IN (
        'PENDING',
        'ACCEPTED',
        'DECLINED'
    )),
    -- resolved_at is set exactly when the proposal leaves PENDING.
    CONSTRAINT handoffs_resolved_at_matches_status CHECK (
        (status = 'PENDING' AND resolved_at IS NULL)
        OR (status <> 'PENDING' AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX handoffs_task_id_idx      ON handoffs (task_id);
CREATE INDEX handoffs_from_user_id_idx ON handoffs (from_user_id);
CREATE INDEX handoffs_to_user_id_idx   ON handoffs (to_user_id);
CREATE INDEX handoffs_created_at_idx   ON handoffs (created_at DESC);
-- A task's transfer history, most recent first.
CREATE INDEX handoffs_task_id_created_at_idx ON handoffs (task_id, created_at DESC);
-- Recipient inbox.
CREATE INDEX handoffs_to_user_id_created_at_idx ON handoffs (to_user_id, created_at DESC);
-- Unanswered proposals awaiting a given recipient - the inbox badge query.
CREATE INDEX handoffs_pending_to_user_id_idx
    ON handoffs (to_user_id, created_at DESC)
    WHERE status = 'PENDING';
-- At most one open proposal per task; declining or accepting frees the slot.
CREATE UNIQUE INDEX handoffs_one_pending_per_task_idx
    ON handoffs (task_id)
    WHERE status = 'PENDING';

COMMENT ON COLUMN handoffs.from_user_id IS 'NULL when the task was previously unowned (claimed from backlog).';

-- -----------------------------------------------------------------------------
-- handoff_briefs
--
-- AI-generated context for a handoff. One brief per handoff; regeneration
-- replaces the row. source_event_ids records which task_events the brief was
-- derived from, so a stale brief is detectable once newer events land.
-- -----------------------------------------------------------------------------
CREATE TABLE handoff_briefs (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    handoff_id       UUID         NOT NULL,
    content          JSONB        NOT NULL,
    source_event_ids JSONB        NOT NULL DEFAULT '[]'::jsonb,
    model            VARCHAR(120) NOT NULL,
    created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT handoff_briefs_handoff_id_fkey
        FOREIGN KEY (handoff_id) REFERENCES handoffs (id)
        ON UPDATE CASCADE ON DELETE CASCADE,

    CONSTRAINT handoff_briefs_handoff_id_key UNIQUE (handoff_id),
    CONSTRAINT handoff_briefs_content_is_object CHECK (jsonb_typeof(content) = 'object'),
    CONSTRAINT handoff_briefs_source_event_ids_is_array
        CHECK (jsonb_typeof(source_event_ids) = 'array'),
    CONSTRAINT handoff_briefs_model_not_blank CHECK (length(btrim(model)) > 0)
);

CREATE INDEX handoff_briefs_handoff_id_idx ON handoff_briefs (handoff_id);
CREATE INDEX handoff_briefs_created_at_idx ON handoff_briefs (created_at DESC);
CREATE INDEX handoff_briefs_model_idx      ON handoff_briefs (model);

COMMENT ON COLUMN handoff_briefs.source_event_ids IS 'JSON array of task_events.id values the brief summarizes.';
COMMENT ON COLUMN handoff_briefs.model IS 'Model identifier used for generation, e.g. claude-sonnet-5.';

-- -----------------------------------------------------------------------------
-- comments
-- -----------------------------------------------------------------------------
CREATE TABLE comments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id    UUID NOT NULL,
    author_id  UUID,
    body       TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),

    CONSTRAINT comments_task_id_fkey
        FOREIGN KEY (task_id) REFERENCES tasks (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT comments_author_id_fkey
        FOREIGN KEY (author_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL,

    CONSTRAINT comments_body_not_blank CHECK (length(btrim(body)) > 0)
);

CREATE INDEX comments_task_id_idx    ON comments (task_id);
CREATE INDEX comments_author_id_idx  ON comments (author_id);
CREATE INDEX comments_created_at_idx ON comments (created_at DESC);
-- Thread view: a task's comments in chronological order.
CREATE INDEX comments_task_id_created_at_idx ON comments (task_id, created_at);

COMMENT ON COLUMN comments.author_id IS 'NULL when the author has been deleted; the body is retained.';

COMMIT;
