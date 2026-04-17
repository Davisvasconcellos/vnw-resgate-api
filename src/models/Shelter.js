const { DataTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require('../config/database');

const Shelter = sequelize.define('Shelter', {
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
  user_id: { // Gestor do abrigo
    type: DataTypes.INTEGER,
    allowNull: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  capacity: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  occupied: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  reference_point: {
    type: DataTypes.STRING,
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
  has_water: { type: DataTypes.BOOLEAN, defaultValue: false },
  has_food: { type: DataTypes.BOOLEAN, defaultValue: false },
  has_bath: { type: DataTypes.BOOLEAN, defaultValue: false },
  has_energy: { type: DataTypes.BOOLEAN, defaultValue: false },
  accepts_pets: { type: DataTypes.BOOLEAN, defaultValue: false },
  has_medical: { type: DataTypes.BOOLEAN, defaultValue: false },
}, {
  tableName: 'shelters',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeValidate: (shelter) => {
      if (!shelter.id_code) {
        shelter.id_code = uuidv4();
      }
    }
  }
});

Shelter.prototype.toJSON = function() {
  const values = Object.assign({}, this.get());
  delete values.id; 
  return values;
};

module.exports = Shelter;
