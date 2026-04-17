'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const dialect = queryInterface.sequelize.options.dialect;

    if (dialect === 'postgres') {
      const rolesToAdd = ['civilian', 'shelter', 'transport', 'boat'];
      
      for (const role of rolesToAdd) {
        try {
          // No Postgres, não podemos rodar ALTER TYPE dentro de uma transaction em muitos casos, então fazemos queries estáticas.
          await queryInterface.sequelize.query(`ALTER TYPE enum_users_role ADD VALUE IF NOT EXISTS '${role}';`);
        } catch (e) {
          console.warn(`Aviso ao adicionar role ${role}:`, e.message);
        }
      }
      
      // Atualiza o default na tabela para 'civilian'
      await queryInterface.sequelize.query(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'civilian';`);
    } else {
      // Abordagem MySQL cross-dialect (re-declara o Enum com os novos valores)
      await queryInterface.changeColumn('users', 'role', {
        type: Sequelize.ENUM('master', 'admin', 'manager', 'volunteer', 'people', 'civilian', 'shelter', 'transport', 'boat'),
        allowNull: false,
        defaultValue: 'civilian'
      });
    }
  },

  async down(queryInterface, Sequelize) {
    const dialect = queryInterface.sequelize.options.dialect;

    if (dialect === 'postgres') {
      // Reverter o default para people
      await queryInterface.sequelize.query(`ALTER TABLE users ALTER COLUMN role SET DEFAULT 'people';`);
    } else {
      await queryInterface.changeColumn('users', 'role', {
        type: Sequelize.ENUM('master', 'admin', 'manager', 'volunteer', 'people', 'civilian', 'shelter', 'transport', 'boat'),
        allowNull: false,
        defaultValue: 'people'
      });
    }
    // Nota: O Postgres não permite DROP VALUE facilmente no Enum, então deixamos eles lá.
  }
};
