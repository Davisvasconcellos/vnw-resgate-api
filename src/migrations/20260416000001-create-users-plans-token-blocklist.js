'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ==========================================
    // TABELA: plans
    // ==========================================
    await queryInterface.createTable('plans', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      name: {
        type: Sequelize.STRING(100),
        allowNull: false
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      price: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    // ==========================================
    // TABELA: users
    // ==========================================
    await queryInterface.createTable('users', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      id_code: {
        type: Sequelize.STRING(255),
        allowNull: true,
        unique: true
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      email: {
        type: Sequelize.STRING(255),
        allowNull: true,
        unique: true
      },
      phone: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      password_hash: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      role: {
        type: Sequelize.ENUM('master', 'admin', 'manager', 'volunteer', 'people'),
        allowNull: false,
        defaultValue: 'people'
      },
      google_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
        unique: true
      },
      google_uid: {
        type: Sequelize.STRING(255),
        allowNull: true,
        unique: true
      },
      avatar_url: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      birth_date: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      address_street: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      address_number: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      address_complement: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      address_neighborhood: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      address_city: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      address_state: {
        type: Sequelize.STRING(2),
        allowNull: true
      },
      address_zip_code: {
        type: Sequelize.STRING(10),
        allowNull: true
      },
      email_verified: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      status: {
        type: Sequelize.ENUM('active', 'inactive', 'pending_verification', 'banned'),
        allowNull: false,
        defaultValue: 'active'
      },
      plan_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'plans',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      plan_start: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      plan_end: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    // ==========================================
    // TABELA: token_blocklist
    // ==========================================
    await queryInterface.createTable('token_blocklist', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        allowNull: false
      },
      token: {
        type: Sequelize.STRING(512),
        allowNull: false,
        unique: true
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('NOW()')
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('token_blocklist');
    await queryInterface.dropTable('users');
    await queryInterface.dropTable('plans');
  }
};
