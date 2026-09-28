-- Chunks remember the hash of their text so unused embedding-cache rows can be
-- found with an index lookup instead of rehashing every chunk.
ALTER TABLE plugin_copilot_8879e97898.memory_chunks ADD COLUMN content_hash text;

CREATE INDEX memory_chunks_content_hash_idx
  ON plugin_copilot_8879e97898.memory_chunks (content_hash, embedding_model);

-- Proactive Copilot state. Everything here is bounded: signals, wakes,
-- notifications and schedule runs are pruned daily by the copilot tick.

-- One row per company. The Copilot stays off until someone turns it on.
CREATE TABLE plugin_copilot_8879e97898.copilot_settings (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  agent_id uuid,
  pulse_interval_minutes integer NOT NULL DEFAULT 30 CHECK (pulse_interval_minutes BETWEEN 5 AND 1440),
  active_start text NOT NULL DEFAULT '08:00',
  active_end text NOT NULL DEFAULT '22:00',
  timezone text NOT NULL DEFAULT 'UTC',
  max_wakes_per_hour integer NOT NULL DEFAULT 4 CHECK (max_wakes_per_hour BETWEEN 1 AND 30),
  max_notifications_per_user_per_day integer NOT NULL DEFAULT 6 CHECK (max_notifications_per_user_per_day BETWEEN 1 AND 50),
  stale_after_hours integer NOT NULL DEFAULT 24 CHECK (stale_after_hours BETWEEN 1 AND 720),
  last_pulse_at timestamptz,
  last_pulse_hash text,
  last_prune_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Events worth the Copilots attention, buffered until the next pulse reads them.
CREATE TABLE plugin_copilot_8879e97898.copilot_signals (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL,
  urgent boolean NOT NULL DEFAULT false,
  entity_type text,
  entity_id text,
  summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);

CREATE INDEX copilot_signals_pending_idx
  ON plugin_copilot_8879e97898.copilot_signals (company_id, created_at)
  WHERE consumed_at IS NULL;

-- Prospective memory: "I will do X by Friday", "remind me when Y ships".
CREATE TABLE plugin_copilot_8879e97898.copilot_commitments (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  owner_kind text NOT NULL CHECK (owner_kind IN ('user', 'agent', 'company')),
  owner_id text,
  text text NOT NULL,
  due_at timestamptz,
  source_issue_id uuid,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_by_kind text,
  created_by_id text,
  last_reminded_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX copilot_commitments_open_idx
  ON plugin_copilot_8879e97898.copilot_commitments (company_id, due_at)
  WHERE status = 'open';

-- Lightweight schedules: wake an agent with a message at a time, on an
-- interval, or on a cron expression. No issue is created per run.
CREATE TABLE plugin_copilot_8879e97898.copilot_schedules (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('at', 'every', 'cron')),
  run_at timestamptz,
  every_minutes integer CHECK (every_minutes IS NULL OR every_minutes >= 5),
  cron_expr text,
  timezone text NOT NULL DEFAULT 'UTC',
  message text NOT NULL,
  target_agent_id uuid,
  system_key text,
  enabled boolean NOT NULL DEFAULT true,
  delete_after_run boolean NOT NULL DEFAULT false,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  run_count integer NOT NULL DEFAULT 0,
  created_by_kind text,
  created_by_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX copilot_schedules_due_idx
  ON plugin_copilot_8879e97898.copilot_schedules (next_run_at)
  WHERE enabled;

CREATE UNIQUE INDEX copilot_schedules_system_key_idx
  ON plugin_copilot_8879e97898.copilot_schedules (company_id, system_key)
  WHERE system_key IS NOT NULL;

CREATE TABLE plugin_copilot_8879e97898.copilot_schedule_runs (
  id uuid PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES plugin_copilot_8879e97898.copilot_schedules(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fired_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  run_id uuid,
  error text
);

CREATE INDEX copilot_schedule_runs_schedule_idx
  ON plugin_copilot_8879e97898.copilot_schedule_runs (schedule_id, fired_at DESC);

-- Every time the pulse (or a schedule) woke the Copilot, for the Activity tab and the hourly cap.
CREATE TABLE plugin_copilot_8879e97898.copilot_wakes (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  reason text NOT NULL,
  summary text NOT NULL,
  item_count integer NOT NULL DEFAULT 0,
  run_id uuid,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX copilot_wakes_company_idx
  ON plugin_copilot_8879e97898.copilot_wakes (company_id, created_at DESC);

-- Proactive messages sent to people, for the per-person daily cap and the Activity tab.
CREATE TABLE plugin_copilot_8879e97898.copilot_notifications (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  issue_id uuid,
  urgency text NOT NULL DEFAULT 'normal',
  excerpt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX copilot_notifications_user_idx
  ON plugin_copilot_8879e97898.copilot_notifications (company_id, user_id, created_at DESC);
