-- v30 D5L (11-database.md §5.7 and §8.2, PLAN §4): the AI queue keeps each task's input and result in
-- ai_task_payloads (ai/payloads.ts): one partition a UTC day of the task's created_at, dropped by the daily
-- housekeeping after AI_TASK_PAYLOAD_KEEP_DAYS (core/db/pg/maintenance). ai_tasks keeps the task's state and metering,
-- and loses the baseline's legacy input and result columns.

-- 1. Tasks written before this file (none in a fresh install, DECISIONS P5): each day gets its partition, then the
--    payloads move over.
DO $$
DECLARE d date;
BEGIN
  FOR d IN SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date FROM ai_tasks ORDER BY 1 LOOP
    IF to_regclass('public.ai_task_payloads_' || to_char(d, 'YYYYMMDD')) IS NULL THEN
      EXECUTE format('CREATE TABLE public.%I PARTITION OF ai_task_payloads FOR VALUES FROM (%L) TO (%L)',
        'ai_task_payloads_' || to_char(d, 'YYYYMMDD'), d, d + 1);
    END IF;
  END LOOP;
END $$;

INSERT INTO ai_task_payloads(task_id, created_on, input, result)
  SELECT id, (created_at AT TIME ZONE 'UTC')::date, input, result FROM ai_tasks
  ON CONFLICT (task_id, created_on) DO NOTHING;

-- 2. A task's payload goes with its row: the queue's prune, the autofill tasks' hour (their input holds page text) and
--    an account's deletion (ai_tasks cascades from users) delete the payload too, at once, not when its day's
--    partition is dropped. No foreign key: a partition is dropped on its own.
CREATE FUNCTION ai_task_payloads_follow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM ai_task_payloads p USING gone g
   WHERE p.task_id = g.id AND p.created_on = (g.created_at AT TIME ZONE 'UTC')::date;
  RETURN NULL;
END $$;

CREATE TRIGGER ai_tasks_delete_payloads AFTER DELETE ON ai_tasks
  REFERENCING OLD TABLE AS gone FOR EACH STATEMENT EXECUTE FUNCTION ai_task_payloads_follow_delete();

-- 3. The legacy columns (PG-0's baseline: "legacy: D5L drops it").
ALTER TABLE ai_tasks DROP COLUMN input, DROP COLUMN result;
