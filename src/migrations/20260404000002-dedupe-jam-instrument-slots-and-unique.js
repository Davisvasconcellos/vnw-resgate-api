'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.transaction(async (t) => {
      const dialect = queryInterface.sequelize.getDialect();
      if (dialect !== 'postgres') return;

      await queryInterface.sequelize.query(
        `
          WITH agg AS (
            SELECT
              jam_song_id,
              instrument,
              MIN(id) AS keep_id,
              SUM(slots)::int AS total_slots,
              BOOL_OR(required) AS required_any,
              BOOL_OR(fallback_allowed) AS fallback_any
            FROM event_jam_song_instrument_slots
            GROUP BY jam_song_id, instrument
            HAVING COUNT(*) > 1
          ),
          upd AS (
            UPDATE event_jam_song_instrument_slots s
            SET
              slots = a.total_slots,
              required = a.required_any,
              fallback_allowed = a.fallback_any
            FROM agg a
            WHERE s.id = a.keep_id
            RETURNING s.id
          )
          DELETE FROM event_jam_song_instrument_slots s
          USING agg a
          WHERE s.jam_song_id = a.jam_song_id
            AND s.instrument = a.instrument
            AND s.id <> a.keep_id;
        `,
        { transaction: t }
      );

      await queryInterface.sequelize.query(
        `
          CREATE UNIQUE INDEX IF NOT EXISTS event_jam_song_instrument_slots_song_instrument_uq
          ON event_jam_song_instrument_slots (jam_song_id, instrument);
        `,
        { transaction: t }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (t) => {
      const dialect = queryInterface.sequelize.getDialect();
      if (dialect !== 'postgres') return;

      await queryInterface.sequelize.query(
        `DROP INDEX IF EXISTS event_jam_song_instrument_slots_song_instrument_uq;`,
        { transaction: t }
      );
    });
  }
};

