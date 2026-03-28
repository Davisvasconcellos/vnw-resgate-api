'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (t) => {
      const dialect = queryInterface.sequelize.getDialect();
      if (dialect !== 'postgres') {
        await queryInterface.addColumn(
          'financial_commissions',
          'commission_type',
          { type: Sequelize.STRING(20), allowNull: true },
          { transaction: t }
        );
        return;
      }

      await queryInterface.addColumn(
        'financial_commissions',
        'commission_type',
        { type: Sequelize.STRING(20), allowNull: true },
        { transaction: t }
      );

      const [cols] = await queryInterface.sequelize.query(
        `
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'financial_commissions'
            AND column_name IN ('salesperson_id', 'commission_seller_id');
        `,
        { transaction: t }
      );

      const colNames = new Set(cols.map((c) => c.column_name));
      if (colNames.has('salesperson_id') && !colNames.has('commission_seller_id')) {
        await queryInterface.sequelize.query(
          `ALTER TABLE financial_commissions RENAME COLUMN salesperson_id TO commission_seller_id;`,
          { transaction: t }
        );
      }

      await queryInterface.addIndex(
        'financial_commissions',
        ['store_id', 'commission_seller_id', 'status'],
        { name: 'financial_commissions_store_seller_status_idx', transaction: t }
      ).catch(() => {});
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (t) => {
      const dialect = queryInterface.sequelize.getDialect();
      if (dialect !== 'postgres') return;

      await queryInterface.removeIndex('financial_commissions', 'financial_commissions_store_seller_status_idx', { transaction: t }).catch(() => {});

      await queryInterface.sequelize.query(
        `
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'financial_commissions'
                AND column_name = 'commission_seller_id'
            ) AND NOT EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'financial_commissions'
                AND column_name = 'salesperson_id'
            ) THEN
              ALTER TABLE financial_commissions RENAME COLUMN commission_seller_id TO salesperson_id;
            END IF;
          END $$;
        `,
        { transaction: t }
      );

      await queryInterface.removeColumn('financial_commissions', 'commission_type', { transaction: t }).catch(() => {});
    });
  }
};

