'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('stores', 'timezone', {
      type: Sequelize.STRING(100),
      allowNull: false,
      defaultValue: 'America/Sao_Paulo'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('stores', 'timezone');
  }
};
