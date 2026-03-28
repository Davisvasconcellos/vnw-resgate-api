const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const FinancialCommission = sequelize.define('FinancialCommission', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true
  },
  id_code: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true
  },
  store_id: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  source_transaction_id_code: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  commission_seller_id: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  commission_type: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  commission_rate: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: true
  },
  commission_amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false
  },
  allow_advance_payment: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'pending'
  },
  paid_transaction_id_code: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  paid_bank_account_id: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  paid_at: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  created_by_user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  }
}, {
  tableName: 'financial_commissions',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeValidate: (commission) => {
      if (!commission.id_code) {
        commission.id_code = `com-${uuidv4()}`;
      }
    }
  }
});

module.exports = FinancialCommission;
