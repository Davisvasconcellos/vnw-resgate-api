'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.bulkInsert('plans', [
      {
        name: 'Free',
        description: 'Plano básico para cidadãos e voluntários individuais.',
        price: 0.00,
        created_at: new Date()
      },
      {
        name: 'Gestor (Shelter)',
        description: 'Plano para gestores de abrigos e casas de apoio.',
        price: 0.00,
        created_at: new Date()
      },
      {
        name: 'Master / Defesa Civil',
        description: 'Acesso total para coordenação de crise e órgãos oficiais.',
        price: 0.00,
        created_at: new Date()
      }
    ], {});
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('plans', null, {});
  }
};
