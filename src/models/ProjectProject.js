const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ProjectProject = sequelize.define('ProjectProject', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  id_code: {
    type: DataTypes.STRING(36),
    allowNull: false,
    unique: true,
    defaultValue: DataTypes.UUIDV4
  },
  store_id: {
    type: DataTypes.STRING(36),
    allowNull: false
  },
  client_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  title: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  logo_url: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  responsible_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  client_party_id: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  start_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  end_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('active', 'paused', 'finished'),
    allowNull: false,
    defaultValue: 'active'
  },
  overhead_multiplier: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: false,
    defaultValue: 1
  },
  created_by_user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  burn_minutes: {
    type: DataTypes.DECIMAL(15, 6),
    allowNull: false,
    defaultValue: 0
  },
  burn_cost_total: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0
  },
  contract_value: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
    defaultValue: 0
  }
}, {
  tableName: 'project_projects',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = ProjectProject;
