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
            AND table_name = 'stores'
            AND column_name = 'slug';
        `,
        { transaction: t }
      );

      if (!cols.length) {
        await queryInterface.addColumn(
          'stores',
          'slug',
          { type: Sequelize.STRING(255), allowNull: true },
          { transaction: t }
        );
      }

      await queryInterface.sequelize.query(
        `
          CREATE UNIQUE INDEX IF NOT EXISTS stores_slug_uq
          ON stores (slug)
          WHERE slug IS NOT NULL;
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
        `DROP INDEX IF EXISTS stores_slug_uq;`,
        { transaction: t }
      );
    });
  }
};

