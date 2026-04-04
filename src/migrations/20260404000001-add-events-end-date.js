'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (t) => {
      const dialect = queryInterface.sequelize.getDialect();
      if (dialect !== 'postgres') return;

      const [cols] = await queryInterface.sequelize.query(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'events'
            AND column_name = 'end_date';
        `,
        { transaction: t }
      );

      if (!cols.length) {
        await queryInterface.addColumn(
          'events',
          'end_date',
          { type: Sequelize.DATEONLY, allowNull: true },
          { transaction: t }
        );
      }

      await queryInterface.addIndex('events', ['end_date'], { name: 'events_end_date_idx', transaction: t });
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (t) => {
      const dialect = queryInterface.sequelize.getDialect();
      if (dialect !== 'postgres') return;

      await queryInterface.removeIndex('events', 'events_end_date_idx', { transaction: t });
      await queryInterface.removeColumn('events', 'end_date', { transaction: t });
    });
  }
};

