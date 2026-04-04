const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const Event = sequelize.define('Event', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  id_code: {
    type: DataTypes.STRING(255),
    allowNull: false,
    unique: true
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  slug: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true
  },
  banner_url: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  start_time: {
    type: DataTypes.TIME,
    allowNull: true
  },
  end_time: {
    type: DataTypes.TIME,
    allowNull: true
  },
  date: {
    type: DataTypes.DATEONLY,
    allowNull: false
  },
  end_date: {
    type: DataTypes.DATEONLY,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: 'draft'
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'users',
      key: 'id'
    }
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  public_url: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  gallery_url: {
    type: DataTypes.STRING(500),
    allowNull: true
  },
  place: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  resp_email: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  resp_name: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  resp_phone: {
    type: DataTypes.STRING(20),
    allowNull: true
  },
  color_1: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  color_2: {
    type: DataTypes.STRING(50),
    allowNull: true
  },
  card_background: {
    type: DataTypes.STRING(255),
    allowNull: true
  },
  card_background_type: {
    type: DataTypes.TINYINT, // 0 = cores (gradient), 1 = imagem
    allowNull: true
  },
  auto_checkin: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  requires_auto_checkin: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  auto_checkin_flow_quest: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false
  },
  checkin_component_config: {
    type: DataTypes.JSON,
    allowNull: true
  },
  store_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'stores',
      key: 'id'
    }
  }
}, {
  tableName: 'events',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  paranoid: true,
  deletedAt: 'deleted_at',
  hooks: {
    beforeValidate: (event) => {
      if (!event.id_code) {
        event.id_code = uuidv4();
      }
      // Normalizar resp_email
      if (event.resp_email && typeof event.resp_email === 'string') {
        event.resp_email = event.resp_email.trim().toLowerCase();
      }
    },
    beforeUpdate: (event) => {
      // Normalizar resp_email
      if (event.resp_email && typeof event.resp_email === 'string') {
        event.resp_email = event.resp_email.trim().toLowerCase();
      }
    }
  }
});

// Suporte a operações em lote
Event.addHook('beforeBulkCreate', (instances) => {
  if (Array.isArray(instances)) {
    for (const inst of instances) {
      if (inst.resp_email && typeof inst.resp_email === 'string') {
        inst.resp_email = inst.resp_email.trim().toLowerCase();
      }
    }
  }
});

Event.addHook('beforeBulkUpdate', (options) => {
  if (options && options.attributes && typeof options.attributes.resp_email === 'string') {
    options.attributes.resp_email = options.attributes.resp_email.trim().toLowerCase();
  }
});

module.exports = Event;
