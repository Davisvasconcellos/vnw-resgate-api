'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.transaction(async (t) => {
      const dialect = queryInterface.sequelize.getDialect();
      if (dialect !== 'postgres') return;

      await queryInterface.addColumn(
        'project_time_entries',
        'last_heartbeat_at',
        { type: Sequelize.DATE, allowNull: true },
        { transaction: t }
      );
      await queryInterface.addColumn(
        'project_time_entries',
        'end_source',
        { type: Sequelize.ENUM('user', 'auto'), allowNull: true },
        { transaction: t }
      );
      await queryInterface.addColumn(
        'project_time_entries',
        'end_reason',
        { type: Sequelize.STRING(100), allowNull: true },
        { transaction: t }
      );

      await queryInterface.addIndex(
        'project_time_entries',
        ['store_id', 'status', 'last_heartbeat_at'],
        { name: 'project_time_entries_store_status_heartbeat_idx', transaction: t }
      );
    });
  },

  async down(queryInterface) {
    await queryInterface.sequelize.transaction(async (t) => {
      const dialect = queryInterface.sequelize.getDialect();
      if (dialect !== 'postgres') return;

      await queryInterface.removeIndex('project_time_entries', 'project_time_entries_store_status_heartbeat_idx', { transaction: t });
      await queryInterface.removeColumn('project_time_entries', 'end_reason', { transaction: t });
      await queryInterface.removeColumn('project_time_entries', 'end_source', { transaction: t });
      await queryInterface.removeColumn('project_time_entries', 'last_heartbeat_at', { transaction: t });
    });
  }
};

