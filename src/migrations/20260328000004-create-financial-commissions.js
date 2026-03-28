'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('financial_commissions', {
      id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        primaryKey: true,
        autoIncrement: true
      },
      id_code: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true
      },
      store_id: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      source_transaction_id_code: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      salesperson_id: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      commission_rate: {
        type: Sequelize.DECIMAL(10, 4),
        allowNull: true
      },
      commission_amount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'pending'
      },
      paid_transaction_id_code: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      paid_bank_account_id: {
        type: Sequelize.STRING(64),
        allowNull: true
      },
      paid_at: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      created_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('financial_commissions', ['store_id', 'source_transaction_id_code'], {
      unique: true,
      name: 'financial_commissions_store_source_uq'
    });

    await queryInterface.addIndex('financial_commissions', ['store_id', 'status'], {
      name: 'financial_commissions_store_status_idx'
    });

    await queryInterface.addIndex('financial_commissions', ['store_id', 'salesperson_id', 'status'], {
      name: 'financial_commissions_store_salesperson_status_idx'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('financial_commissions');
  }
};

