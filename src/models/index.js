const { sequelize } = require('../config/database');

// Import models
const Plan = require('./Plan');
const User = require('./User');
const TokenBlocklist = require('./TokenBlocklist');

// Define associations

// Plan ↔ User
Plan.hasMany(User, { foreignKey: 'plan_id', as: 'users' });
User.belongsTo(Plan, { foreignKey: 'plan_id', as: 'plan' });

module.exports = {
  sequelize,
  Plan,
  User,
  TokenBlocklist
};
