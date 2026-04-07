const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ProjectMember = sequelize.define('ProjectMember', {
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
  project_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  role: {
    type: DataTypes.ENUM('manager', 'member', 'viewer'),
    allowNull: false,
    defaultValue: 'member'
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive'),
    allowNull: false,
    defaultValue: 'active'
  },
  start_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  end_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  hourly_rate_override: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  overhead_multiplier_override: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  timezone_override: {
    type: DataTypes.STRING(100),
    allowNull: true
  }
}, {
  tableName: 'project_members',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = ProjectMember;

