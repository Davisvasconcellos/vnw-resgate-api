const { sequelize } = require('../config/database');

// Import models
const Plan = require('./Plan');
const User = require('./User');
const TokenBlocklist = require('./TokenBlocklist');
const HelpRequest = require('./HelpRequest');
const MissingPerson = require('./MissingPerson');
const Shelter = require('./Shelter');
const ShelterEntry = require('./ShelterEntry');
const VolunteerProfile = require('./VolunteerProfile');
const ShelterVolunteer = require('./ShelterVolunteer');

// Define associations

// Plan ↔ User
Plan.hasMany(User, { foreignKey: 'plan_id', as: 'users' });
User.belongsTo(Plan, { foreignKey: 'plan_id', as: 'plan' });

// HelpRequest ↔ User
User.hasMany(HelpRequest, { foreignKey: 'user_id', as: 'help_requests_created' });
HelpRequest.belongsTo(User, { foreignKey: 'user_id', as: 'requester' });

User.hasMany(HelpRequest, { foreignKey: 'accepted_by', as: 'help_requests_accepted' });
HelpRequest.belongsTo(User, { foreignKey: 'accepted_by', as: 'volunteer' });

// HelpRequest ↔ Shelter
Shelter.hasMany(HelpRequest, { foreignKey: 'shelter_id', as: 'hospitality_requests' });
HelpRequest.belongsTo(Shelter, { foreignKey: 'shelter_id', as: 'shelter' });

// MissingPerson ↔ User
User.hasMany(MissingPerson, { foreignKey: 'user_id', as: 'missing_persons_reported' });
MissingPerson.belongsTo(User, { foreignKey: 'user_id', as: 'reporter' });

// Shelter ↔ User (Gestor)
User.hasMany(Shelter, { foreignKey: 'user_id', as: 'managed_shelters' });
Shelter.belongsTo(User, { foreignKey: 'user_id', as: 'manager' });

// Shelter ↔ ShelterEntry
Shelter.hasMany(ShelterEntry, { foreignKey: 'shelter_id', as: 'entries' });
ShelterEntry.belongsTo(Shelter, { foreignKey: 'shelter_id', as: 'shelter' });

// VolunteerProfile ↔ User
User.hasOne(VolunteerProfile, { foreignKey: 'user_id', as: 'volunteer_profile' });
VolunteerProfile.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// Shelter ↔ User (ShelterVolunteers pivot)
Shelter.belongsToMany(User, { through: ShelterVolunteer, foreignKey: 'shelter_id', otherKey: 'user_id', as: 'volunteers' });
User.belongsToMany(Shelter, { through: ShelterVolunteer, foreignKey: 'user_id', otherKey: 'shelter_id', as: 'shelter_invites' });

// ShelterVolunteer ↔ HelpRequest (Vínculo da atividade)
HelpRequest.hasMany(ShelterVolunteer, { foreignKey: 'help_request_id', as: 'volunteers' });
ShelterVolunteer.belongsTo(HelpRequest, { foreignKey: 'help_request_id', as: 'help_request' });

// ShelterVolunteer ↔ User
User.hasMany(ShelterVolunteer, { foreignKey: 'user_id', as: 'assignments' });
ShelterVolunteer.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// ShelterVolunteer ↔ Shelter
Shelter.hasMany(ShelterVolunteer, { foreignKey: 'shelter_id', as: 'team_members' });
ShelterVolunteer.belongsTo(Shelter, { foreignKey: 'shelter_id', as: 'shelter' });

module.exports = {
  sequelize,
  Plan,
  User,
  TokenBlocklist,
  HelpRequest,
  MissingPerson,
  Shelter,
  ShelterEntry,
  VolunteerProfile,
  ShelterVolunteer
};
