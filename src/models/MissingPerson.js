const { DataTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require('../config/database');

const MissingPerson = sequelize.define('MissingPerson', {
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
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  age: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('missing', 'found'),
    allowNull: false,
    defaultValue: 'missing'
  },
  last_seen_location: {
    type: DataTypes.STRING,
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
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
  photo_url: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'missing_persons',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeValidate: (person) => {
      if (!person.id_code) {
        person.id_code = uuidv4();
      }
    }
  }
});

MissingPerson.prototype.toJSON = function() {
  const values = Object.assign({}, this.get());
  delete values.id; 
  return values;
};

module.exports = MissingPerson;
