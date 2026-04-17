const { DataTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require('../config/database');

const HelpRequest = sequelize.define('HelpRequest', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  id_code: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  shelter_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  accepted_by: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  type: {
    type: DataTypes.ENUM('rescue', 'shelter', 'medical', 'food', 'transport', 'boat', 'volunteer'),
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('pending', 'viewed', 'attending', 'resolved'),
    allowNull: false,
    defaultValue: 'pending'
  },
  urgency: {
    type: DataTypes.ENUM('high', 'medium', 'low'),
    allowNull: false,
    defaultValue: 'high'
  },
  people_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  lat: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true
  },
  lng: {
    type: DataTypes.DECIMAL(10, 7),
    allowNull: true
  },
  photo_url: {
    type: DataTypes.STRING,
    allowNull: true
  },
  reporter_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  reporter_phone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  volunteer_message: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  total_slots: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
    allowNull: false
  },
  dropoff_location: {
    type: DataTypes.STRING,
    allowNull: true
  },
  finished_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  device_id: {
    type: DataTypes.STRING,
    allowNull: true
  },
  is_verified: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  sub_type: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'help_requests',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeValidate: (request) => {
      if (!request.id_code) {
        request.id_code = uuidv4();
      }
    }
  }
});

HelpRequest.prototype.toJSON = function() {
  const values = Object.assign({}, this.get());
  delete values.id; // Nunca expor ID sequencial
  return values;
};

module.exports = HelpRequest;
