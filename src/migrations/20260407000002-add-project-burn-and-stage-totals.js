'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add columns to project_projects
    await queryInterface.addColumn('project_projects', 'burn_minutes', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0
    });
    await queryInterface.addColumn('project_projects', 'burn_cost_total', {
      type: Sequelize.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0
    });

    // Add columns to project_stages
    await queryInterface.addColumn('project_stages', 'total_minutes', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0
    });
    await queryInterface.addColumn('project_stages', 'total_amount', {
      type: Sequelize.DECIMAL(15, 2),
      allowNull: false,
      defaultValue: 0
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('project_projects', 'burn_minutes');
    await queryInterface.removeColumn('project_projects', 'burn_cost_total');
    await queryInterface.removeColumn('project_stages', 'total_minutes');
    await queryInterface.removeColumn('project_stages', 'total_amount');
  }
};
