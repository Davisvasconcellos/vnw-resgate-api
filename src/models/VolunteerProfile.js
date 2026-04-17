const { DataTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require('../config/database');

const VolunteerProfile = sequelize.define('VolunteerProfile', {
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
    allowNull: false
  },
  offer_types: {
    type: DataTypes.JSON, // ['transport', 'boat', 'volunteer']
    allowNull: false,
    defaultValue: []
  },
  car_details: {
    type: DataTypes.JSON, // { type, seats, region, offroad }
    allowNull: true
  },
  boat_details: {
    type: DataTypes.JSON, // { type, spots, region, vests }
    allowNull: true
  },
  region: {
    type: DataTypes.STRING,
    allowNull: true
  },
  availability: {
    type: DataTypes.ENUM('full', 'morning', 'afternoon', 'night'),
    allowNull: true
  },
  skills: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'volunteer_profiles',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeValidate: (profile) => {
      if (!profile.id_code) {
        profile.id_code = uuidv4();
      }
    }
  }
});

VolunteerProfile.prototype.toJSON = function() {
  const values = Object.assign({}, this.get());
  delete values.id; 
  return values;
};

module.exports = VolunteerProfile;
