const { sequelize } = require('../config/database');
const { ProjectNotification } = require('../models');

const safeString = (v) => (v === undefined || v === null) ? '' : String(v);

const createNotificationsForAutoClosedSessions = async (rows) => {
  for (const r of rows) {
    const storeId = safeString(r.store_id);
    const userId = Number(r.user_id);
    const date = safeString(r.local_date);
    const sessionId = safeString(r.session_id_code);
    const cutoffTime = safeString(r.cutoff_time);
    const dedupeKey = `timesheet:auto_close:${storeId}:${userId}:${date}`;

    try {
      await ProjectNotification.create({
        store_id: storeId,
        user_id: userId,
        type: 'timesheet_auto_closed',
        dedupe_key: dedupeKey,
        status: 'unread',
        payload: { date, session_id: sessionId, cutoff_time: cutoffTime }
      });
    } catch (e) {
      if (e && e.name === 'SequelizeUniqueConstraintError') continue;
      throw e;
    }
  }
};

const autoCloseProjectSessionsByCutoff = async () => {
  const [rows] = await sequelize.query(
    `
      WITH base AS (
        SELECT
          s.id AS session_id,
          s.id_code AS session_id_code,
          s.store_id,
          s.user_id,
          COALESCE(cfg.timezone, 'America/Sao_Paulo') AS tz,
          COALESCE(cfg.daily_auto_cutoff_time, '18:00:00'::time) AS cutoff_time
        FROM project_sessions s
        LEFT JOIN LATERAL (
          SELECT mc.timezone, mc.daily_auto_cutoff_time
          FROM project_member_costs mc
          WHERE mc.store_id = s.store_id
            AND mc.user_id = s.user_id
            AND mc.start_date <= (s.check_in_at AT TIME ZONE COALESCE(mc.timezone, 'America/Sao_Paulo'))::date
            AND (mc.end_date IS NULL OR mc.end_date >= (s.check_in_at AT TIME ZONE COALESCE(mc.timezone, 'America/Sao_Paulo'))::date)
          ORDER BY mc.start_date DESC
          LIMIT 1
        ) cfg ON true
        WHERE s.check_out_at IS NULL
      ),
      calc AS (
        SELECT
          b.*,
          (b.cutoff_time)::text AS cutoff_time_text,
          (s.check_in_at AT TIME ZONE b.tz) AS local_check_in,
          ((s.check_in_at AT TIME ZONE b.tz)::date) AS local_date,
          (
            LEAST(
              (
                (
                  (
                    ((s.check_in_at AT TIME ZONE b.tz)::date)::timestamp + b.cutoff_time
                    + CASE WHEN (s.check_in_at AT TIME ZONE b.tz)::time > b.cutoff_time THEN interval '1 day' ELSE interval '0 day' END
                  ) AT TIME ZONE b.tz
                )
              ),
              (s.check_in_at + interval '12 hours')
            )
          ) AS cutoff_at
        FROM base b
        JOIN project_sessions s ON s.id = b.session_id
      ),
      upd AS (
        UPDATE project_sessions s
        SET
          check_out_at = c.cutoff_at,
          check_out_source = 'auto',
          check_out_reason = 'forgotten_checkout',
          updated_at = now()
        FROM calc c
        WHERE s.id = c.session_id
          AND now() >= c.cutoff_at
          AND NOT EXISTS (
            SELECT 1
            FROM project_time_entries e
            WHERE e.session_id = s.id
              AND (
                e.status = 'running'
                OR e.start_at > c.cutoff_at
                OR (e.last_heartbeat_at IS NOT NULL AND e.last_heartbeat_at > c.cutoff_at)
              )
          )
        RETURNING
          s.id AS session_id,
          s.id_code AS session_id_code,
          s.store_id,
          s.user_id,
          c.local_date AS local_date,
          c.cutoff_time_text AS cutoff_time
      )
      SELECT * FROM upd;
    `
  );

  if (!rows.length) return [];

  const sessionIds = rows.map(r => Number(r.session_id)).filter(Boolean);
  await sequelize.query(
    `
      UPDATE project_time_entries e
      SET
        end_at = s.check_out_at,
        status = 'closed',
        end_source = 'auto',
        end_reason = 'session_cutoff',
        minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (s.check_out_at - e.start_at)) / 60)::int),
        updated_at = now()
      FROM project_sessions s
      WHERE e.session_id = s.id
        AND e.status = 'running'
        AND s.check_out_source = 'auto'
        AND s.check_out_reason = 'forgotten_checkout'
        AND s.id IN (:sessionIds);
    `,
    { replacements: { sessionIds } }
  );

  await createNotificationsForAutoClosedSessions(rows);
  return rows;
};

const createNotificationsForStaleRunningEntries = async (rows) => {
  for (const r of rows) {
    const storeId = safeString(r.store_id);
    const userId = Number(r.user_id);
    const date = safeString(r.local_date);
    const timeEntryId = safeString(r.time_entry_id_code);
    const dedupeKey = `timesheet:stale_running:${storeId}:${userId}:${date}:${timeEntryId}`;

    try {
      await ProjectNotification.create({
        store_id: storeId,
        user_id: userId,
        type: 'timesheet_running_stale',
        dedupe_key: dedupeKey,
        status: 'unread',
        payload: { date, time_entry_id: timeEntryId, last_heartbeat_at: r.last_heartbeat_at }
      });
    } catch (e) {
      if (e && e.name === 'SequelizeUniqueConstraintError') continue;
      throw e;
    }
  }
};

const closeStaleRunningEntries = async () => {
  const [rows] = await sequelize.query(
    `
      WITH stale AS (
        SELECT
          e.id AS time_entry_id,
          e.id_code AS time_entry_id_code,
          e.store_id,
          e.user_id,
          e.last_heartbeat_at,
          (e.last_heartbeat_at AT TIME ZONE 'America/Sao_Paulo')::date AS local_date
        FROM project_time_entries e
        WHERE e.status = 'running'
          AND e.last_heartbeat_at IS NOT NULL
          AND e.last_heartbeat_at <= now() - interval '15 minutes'
      ),
      upd AS (
        UPDATE project_time_entries e
        SET
          end_at = s.last_heartbeat_at,
          status = 'closed',
          end_source = 'auto',
          end_reason = 'heartbeat_timeout',
          minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (s.last_heartbeat_at - e.start_at)) / 60)::int),
          updated_at = now()
        FROM stale s
        WHERE e.id = s.time_entry_id
        RETURNING
          e.id_code AS time_entry_id_code,
          e.store_id,
          e.user_id,
          s.local_date AS local_date,
          s.last_heartbeat_at
      )
      SELECT * FROM upd;
    `
  );

  if (!rows.length) return [];

  await createNotificationsForStaleRunningEntries(rows.map(r => ({
    store_id: r.store_id,
    user_id: r.user_id,
    local_date: r.local_date,
    time_entry_id_code: r.time_entry_id_code,
    last_heartbeat_at: r.last_heartbeat_at
  })));

  return rows;
};

module.exports = {
  autoCloseProjectSessionsByCutoff,
  closeStaleRunningEntries
};
