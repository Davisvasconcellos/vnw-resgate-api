const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const Store = sequelize.define('Store', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  id_code: {
    type: DataTypes.STRING(36),
    allowNull: false,
    unique: true,
    defaultValue: uuidv4
  },
  organization_id: {
    type: DataTypes.INTEGER,
    allowNull: true // Will be migrated to false later
    // References Organization model
  },
  owner_id: {
    type: DataTypes.INTEGER,
    allowNull: true // Legacy field, eventually replaced by organization owner
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  slug: {
    type: DataTypes.STRING(255),
    allowNull: true, // Legacy stores might not have slug initially
    unique: true
  },
  // Contact & Social
  email: { type: DataTypes.STRING(255), allowNull: true },
  phone: { type: DataTypes.STRING(255), allowNull: true },
  website: { type: DataTypes.STRING(255), allowNull: true },
  instagram_handle: { type: DataTypes.STRING(255), allowNull: true },
  facebook_handle: { type: DataTypes.STRING(255), allowNull: true },
  
  // Legal & Info
  cnpj: { type: DataTypes.STRING(255), allowNull: true },
  legal_name: { type: DataTypes.STRING(255), allowNull: true },
  description: { type: DataTypes.TEXT, allowNull: true },
  capacity: { type: DataTypes.INTEGER, allowNull: true },
  type: { type: DataTypes.STRING(255), allowNull: true }, // e.g., 'pub', 'restaurant'

  // Address
  city: { type: DataTypes.STRING(255), allowNull: true },
  address: { type: DataTypes.STRING(500), allowNull: true },
  zip_code: { type: DataTypes.STRING(255), allowNull: true },
  address_street: { type: DataTypes.STRING(255), allowNull: true },
  address_number: { type: DataTypes.STRING(255), allowNull: true },
  address_complement: { type: DataTypes.STRING(255), allowNull: true },
  address_neighborhood: { type: DataTypes.STRING(255), allowNull: true },
  address_state: { type: DataTypes.STRING(255), allowNull: true },
  latitude: { type: DataTypes.DECIMAL(10, 8), allowNull: true },
  longitude: { type: DataTypes.DECIMAL(11, 8), allowNull: true },
  timezone: { type: DataTypes.STRING(100), allowNull: false, defaultValue: 'America/Sao_Paulo' },

  // Media
  logo_url: { type: DataTypes.STRING(255), allowNull: true },
  banner_url: { type: DataTypes.STRING(255), allowNull: true },

  config: {
    type: DataTypes.JSONB, // Stores active modules, theme, settings, etc.
    allowNull: false,
    defaultValue: {}
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive'),
    allowNull: false,
    defaultValue: 'active'
  }
}, {
  tableName: 'stores',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = Store;
