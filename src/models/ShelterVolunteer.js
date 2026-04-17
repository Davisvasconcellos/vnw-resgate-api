const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const ShelterVolunteer = sequelize.define('ShelterVolunteer', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  shelter_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  help_request_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('pending', 'accepted', 'finished'),
    allowNull: false,
    defaultValue: 'pending'
  }
}, {
  tableName: 'shelter_volunteers',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

// Sem id_code, pois é apenas uma tabela pivot
ShelterVolunteer.prototype.toJSON = function() {
  const values = Object.assign({}, this.get());
  delete values.id;
  return values;
};

module.exports = ShelterVolunteer;
