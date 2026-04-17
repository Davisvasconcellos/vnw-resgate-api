const { DataTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require('../config/database');

const ShelterEntry = sequelize.define('ShelterEntry', {
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
  shelter_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true
  },
  people_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  status: {
    type: DataTypes.ENUM('request', 'incoming', 'present', 'left'),
    allowNull: false,
    defaultValue: 'request'
  },
  assume_message: {
    type: DataTypes.TEXT,
    allowNull: true
  }
}, {
  tableName: 'shelter_entries',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeValidate: (entry) => {
      if (!entry.id_code) {
        entry.id_code = uuidv4();
      }
    },
    // Controle automático de ocupação (Lotação)
    afterCreate: async (entry, options) => {
      if (entry.status === 'present') {
        await sequelize.models.Shelter.increment('occupied', {
          by: entry.people_count,
          where: { id: entry.shelter_id },
          transaction: options.transaction
        });
      }
    },
    afterUpdate: async (entry, options) => {
      const prevStatus = entry.previous('status');
      const currentStatus = entry.status;
      
      if (prevStatus !== 'present' && currentStatus === 'present') {
        await sequelize.models.Shelter.increment('occupied', {
          by: entry.people_count,
          where: { id: entry.shelter_id },
          transaction: options.transaction
        });
      } else if (prevStatus === 'present' && currentStatus !== 'present') {
        const shelter = await sequelize.models.Shelter.findByPk(entry.shelter_id, { transaction: options.transaction });
        // Impede que fique negativo
        if (shelter && shelter.occupied >= entry.people_count) {
          await shelter.decrement('occupied', { by: entry.people_count, transaction: options.transaction });
        } else if (shelter) {
          shelter.occupied = 0;
          await shelter.save({ transaction: options.transaction });
        }
      }
    },
    afterDestroy: async (entry, options) => {
       if (entry.status === 'present') {
        const shelter = await sequelize.models.Shelter.findByPk(entry.shelter_id, { transaction: options.transaction });
        if (shelter && shelter.occupied >= entry.people_count) {
          await shelter.decrement('occupied', { by: entry.people_count, transaction: options.transaction });
        } else if (shelter) {
          shelter.occupied = 0;
          await shelter.save({ transaction: options.transaction });
        }
       }
    }
  }
});

ShelterEntry.prototype.toJSON = function() {
  const values = Object.assign({}, this.get());
  delete values.id; 
  return values;
};

module.exports = ShelterEntry;
