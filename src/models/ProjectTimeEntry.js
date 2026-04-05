const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ProjectTimeEntry = sequelize.define('ProjectTimeEntry', {
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
  session_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  project_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  stage_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  task_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('running', 'closed'),
    allowNull: false,
    defaultValue: 'running'
  },
  start_at: {
    type: DataTypes.DATE,
    allowNull: false
  },
  end_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  last_heartbeat_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  end_source: {
    type: DataTypes.ENUM('user', 'auto'),
    allowNull: true
  },
  end_reason: {
    type: DataTypes.STRING(100),
    allowNull: true
  },
  minutes: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  hourly_rate_snapshot: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true
  },
  overhead_multiplier_snapshot: {
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true
  },
  cost_amount_snapshot: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true
  }
}, {
  tableName: 'project_time_entries',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = ProjectTimeEntry;
