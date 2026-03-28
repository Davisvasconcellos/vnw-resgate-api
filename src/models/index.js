const { sequelize } = require('../config/database');

// Import models
const Plan = require('./Plan');
const Store = require('./Store');
const User = require('./User');
const TokenBlocklist = require('./TokenBlocklist');
const StoreUser = require('./StoreUser');
const Product = require('./Product');
const FootballTeam = require('./FootballTeam');
const Order = require('./Order');
const OrderItem = require('./OrderItem');
const PixPayment = require('./PixPayment');
const Message = require('./Message');
const StoreSchedule = require('./StoreSchedule');
const FinancialTransaction = require('./FinancialTransaction');
const FinancialCommission = require('./FinancialCommission');
const BankAccount = require('./BankAccount');
const Event = require('./Event');
const EventQuestion = require('./EventQuestion');
const EventResponse = require('./EventResponse');
const EventAnswer = require('./EventAnswer');
const EventGuest = require('./EventGuest');
const EventJam = require('./EventJam');
const EventJamSong = require('./EventJamSong');
const EventJamSongInstrumentSlot = require('./EventJamSongInstrumentSlot');
const EventJamSongCandidate = require('./EventJamSongCandidate');
const EventJamSongRating = require('./EventJamSongRating');
const Party = require('./Party');
const FinCategory = require('./FinCategory');
const FinCostCenter = require('./FinCostCenter');
const FinTag = require('./FinTag');
const FinRecurrence = require('./FinRecurrence');
const SysModule = require('./SysModule');
const EventJamMusicSuggestion = require('./EventJamMusicSuggestion');
const EventJamMusicSuggestionParticipant = require('./EventJamMusicSuggestionParticipant');
const EventJamMusicCatalog = require('./EventJamMusicCatalog');
const Organization = require('./Organization');
const StoreMember = require('./StoreMember');
const StoreInvite = require('./StoreInvite');

// Define associations

// Organization Associations
Organization.belongsTo(User, { foreignKey: 'owner_id', as: 'owner' });
User.hasMany(Organization, { foreignKey: 'owner_id', as: 'ownedOrganizations' });

Organization.hasMany(Store, { foreignKey: 'organization_id', as: 'stores' });
Store.belongsTo(Organization, { foreignKey: 'organization_id', as: 'organization' });

// StoreMember Associations (Pivot)
Store.hasMany(StoreMember, { foreignKey: 'store_id', as: 'memberships' });
StoreMember.belongsTo(Store, { foreignKey: 'store_id', as: 'store' });

User.hasMany(StoreMember, { foreignKey: 'user_id', as: 'storeMemberships' });
StoreMember.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

Store.hasMany(StoreInvite, { foreignKey: 'store_id', as: 'invites' });
StoreInvite.belongsTo(Store, { foreignKey: 'store_id', as: 'store' });

User.hasMany(StoreInvite, { foreignKey: 'created_by_user_id', as: 'createdStoreInvites' });
StoreInvite.belongsTo(User, { foreignKey: 'created_by_user_id', as: 'createdBy' });

User.hasMany(StoreInvite, { foreignKey: 'invited_user_id', as: 'receivedStoreInvites' });
StoreInvite.belongsTo(User, { foreignKey: 'invited_user_id', as: 'invitedUser' });

User.hasMany(StoreInvite, { foreignKey: 'accepted_user_id', as: 'acceptedStoreInvites' });
StoreInvite.belongsTo(User, { foreignKey: 'accepted_user_id', as: 'acceptedUser' });

// Many-to-Many Store <-> User via StoreMember
Store.belongsToMany(User, { through: StoreMember, foreignKey: 'store_id', otherKey: 'user_id', as: 'members' });
User.belongsToMany(Store, { through: StoreMember, foreignKey: 'user_id', otherKey: 'store_id', as: 'memberStores' });

// SysModule Associations
SysModule.associate({ User });
User.associate({ SysModule });

// EventJamMusicSuggestion Associations
// Note: Some associations might be duplicated if defined below again. Keeping the ones below as authoritative.

// EventJamMusicCatalog Associations
EventJamMusicCatalog.hasMany(EventJamSong, { foreignKey: 'catalog_id', as: 'jamSongs' });
EventJamSong.belongsTo(EventJamMusicCatalog, { foreignKey: 'catalog_id', as: 'catalog' });

EventJamMusicCatalog.hasMany(EventJamMusicSuggestion, { foreignKey: 'catalog_id', as: 'suggestions' });
EventJamMusicSuggestion.belongsTo(EventJamMusicCatalog, { foreignKey: 'catalog_id', as: 'catalog' });


// Plan associations
Plan.hasMany(User, { foreignKey: 'plan_id', as: 'users' });
User.belongsTo(Plan, { foreignKey: 'plan_id', as: 'plan' });



// Store associations
Store.hasMany(Product, { foreignKey: 'store_id', as: 'products' });
Product.belongsTo(Store, { foreignKey: 'store_id', as: 'store' });


Store.hasMany(Order, { foreignKey: 'store_id', as: 'orders' });
Order.belongsTo(Store, { foreignKey: 'store_id', as: 'store' });

Store.hasMany(Message, { foreignKey: 'store_id', as: 'messages' });
Message.belongsTo(Store, { foreignKey: 'store_id', as: 'store' });

// Associação de Proprietário da Loja (Store Owner)
User.hasMany(Store, { foreignKey: 'owner_id', as: 'ownedStores' });
Store.belongsTo(User, { foreignKey: 'owner_id', as: 'owner' });

// Associação de Horários da Loja (Store Schedules)
Store.hasMany(StoreSchedule, { foreignKey: 'store_id', as: 'schedules' });
StoreSchedule.belongsTo(Store, { foreignKey: 'store_id', as: 'store' });



// User associations
User.hasMany(Order, { foreignKey: 'user_id', as: 'orders' });
Order.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

User.hasMany(Order, { foreignKey: 'waiter_id', as: 'waiterOrders' });
Order.belongsTo(User, { foreignKey: 'waiter_id', as: 'waiter' });

User.hasMany(Message, { foreignKey: 'from_user_id', as: 'sentMessages' });
Message.belongsTo(User, { foreignKey: 'from_user_id', as: 'fromUser' });

User.hasMany(Message, { foreignKey: 'to_user_id', as: 'receivedMessages' });
Message.belongsTo(User, { foreignKey: 'to_user_id', as: 'toUser' });

// StoreUser associations (Many-to-Many between User and Store)
User.belongsToMany(Store, { 
  through: StoreUser, 
  foreignKey: 'user_id', 
  otherKey: 'store_id',
  as: 'stores'
});
Store.belongsToMany(User, { 
  through: StoreUser, 
  foreignKey: 'store_id', 
  otherKey: 'user_id',
  as: 'users'
});

// Product associations
Product.hasMany(OrderItem, { foreignKey: 'product_id', as: 'orderItems' });
OrderItem.belongsTo(Product, { foreignKey: 'product_id', as: 'product' });

// Order associations
Order.hasMany(OrderItem, { foreignKey: 'order_id', as: 'items' });
OrderItem.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });

Order.hasMany(PixPayment, { foreignKey: 'order_id', as: 'pixPayments' });
PixPayment.belongsTo(Order, { foreignKey: 'order_id', as: 'order' });

// Team Associações:
User.belongsTo(FootballTeam, { foreignKey: 'team_user', as: 'team' });
FootballTeam.hasMany(User, { foreignKey: 'team_user', as: 'users' });

// Event associations
Event.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
User.hasMany(Event, { foreignKey: 'created_by', as: 'createdEvents' });

Event.hasMany(EventQuestion, { foreignKey: 'event_id', as: 'questions' });
EventQuestion.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });

Event.hasMany(EventResponse, { foreignKey: 'event_id', as: 'responses' });
EventResponse.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });

EventResponse.belongsTo(EventGuest, { foreignKey: 'guest_id', as: 'guest' });
EventGuest.hasMany(EventResponse, { foreignKey: 'guest_id', as: 'responses' });

// Vincular respostas ao usuário (quando autenticado)
EventResponse.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(EventResponse, { foreignKey: 'user_id', as: 'eventResponses' });

EventResponse.hasMany(EventAnswer, { foreignKey: 'response_id', as: 'answers' });
EventAnswer.belongsTo(EventResponse, { foreignKey: 'response_id', as: 'response' });

EventQuestion.hasMany(EventAnswer, { foreignKey: 'question_id', as: 'answers' });
EventAnswer.belongsTo(EventQuestion, { foreignKey: 'question_id', as: 'question' });

// EventGuest associations
Event.hasMany(EventGuest, { foreignKey: 'event_id', as: 'guests' });
EventGuest.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
User.hasMany(EventGuest, { foreignKey: 'user_id', as: 'eventGuests' });
EventGuest.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

Event.hasMany(EventJam, { foreignKey: 'event_id', as: 'jams' });
EventJam.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });

EventJam.hasMany(EventJamSong, { foreignKey: 'jam_id', as: 'songs' });
EventJamSong.belongsTo(EventJam, { foreignKey: 'jam_id', as: 'jam' });

EventJamSong.hasMany(EventJamSongInstrumentSlot, { foreignKey: 'jam_song_id', as: 'instrumentSlots' });
EventJamSongInstrumentSlot.belongsTo(EventJamSong, { foreignKey: 'jam_song_id', as: 'song' });

EventJamSong.hasMany(EventJamSongCandidate, { foreignKey: 'jam_song_id', as: 'candidates' });
EventJamSongCandidate.belongsTo(EventJamSong, { foreignKey: 'jam_song_id', as: 'song' });
EventJamSongCandidate.belongsTo(EventGuest, { foreignKey: 'event_guest_id', as: 'guest' });
EventGuest.hasMany(EventJamSongCandidate, { foreignKey: 'event_guest_id', as: 'jamSongCandidates' });

EventJamSong.hasMany(EventJamSongRating, { foreignKey: 'jam_song_id', as: 'ratings' });
EventJamSongRating.belongsTo(EventJamSong, { foreignKey: 'jam_song_id', as: 'song' });
EventJamSongRating.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(EventJamSongRating, { foreignKey: 'user_id', as: 'jamSongRatings' });
EventJamSongRating.belongsTo(EventGuest, { foreignKey: 'event_guest_id', as: 'guest' });
EventGuest.hasMany(EventJamSongRating, { foreignKey: 'event_guest_id', as: 'jamSongRatings' });

User.hasMany(FinancialTransaction, { foreignKey: 'created_by_user_id', as: 'financialTransactions' });
FinancialTransaction.belongsTo(User, { foreignKey: 'created_by_user_id', as: 'createdBy' });

// BankAccount associations
BankAccount.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'id_code', as: 'store' });
Store.hasMany(BankAccount, { foreignKey: 'store_id', sourceKey: 'id_code', as: 'bankAccounts' });

FinancialTransaction.belongsTo(BankAccount, { foreignKey: 'bank_account_id', targetKey: 'id_code', as: 'bankAccount' });
BankAccount.hasMany(FinancialTransaction, { foreignKey: 'bank_account_id', sourceKey: 'id_code', as: 'transactions' });

// Party associations
Party.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'id_code', as: 'store' });
Store.hasMany(Party, { foreignKey: 'store_id', sourceKey: 'id_code', as: 'parties' });

FinancialTransaction.belongsTo(Party, { foreignKey: 'party_id', targetKey: 'id_code', as: 'party' });
Party.hasMany(FinancialTransaction, { foreignKey: 'party_id', sourceKey: 'id_code', as: 'transactions' });

FinancialCommission.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'id_code', as: 'store' });
Store.hasMany(FinancialCommission, { foreignKey: 'store_id', sourceKey: 'id_code', as: 'financialCommissions' });

FinancialCommission.belongsTo(FinancialTransaction, {
  foreignKey: 'source_transaction_id_code',
  targetKey: 'id_code',
  as: 'sourceTransaction'
});
FinancialTransaction.hasMany(FinancialCommission, {
  foreignKey: 'source_transaction_id_code',
  sourceKey: 'id_code',
  as: 'commissions'
});

FinancialCommission.belongsTo(FinancialTransaction, {
  foreignKey: 'paid_transaction_id_code',
  targetKey: 'id_code',
  as: 'paidTransaction'
});
FinancialTransaction.hasMany(FinancialCommission, {
  foreignKey: 'paid_transaction_id_code',
  sourceKey: 'id_code',
  as: 'paidCommissions'
});

FinancialCommission.belongsTo(Party, { foreignKey: 'commission_seller_id', targetKey: 'id_code', as: 'commissionSeller' });
Party.hasMany(FinancialCommission, { foreignKey: 'commission_seller_id', sourceKey: 'id_code', as: 'commissions' });

// FinCategory associations
FinCategory.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'id_code', as: 'store' });
Store.hasMany(FinCategory, { foreignKey: 'store_id', sourceKey: 'id_code', as: 'finCategories' });

FinancialTransaction.belongsTo(FinCategory, { foreignKey: 'category_id', targetKey: 'id_code', as: 'finCategory' });
FinCategory.hasMany(FinancialTransaction, { foreignKey: 'category_id', sourceKey: 'id_code', as: 'transactions' });

// FinCostCenter associations
FinCostCenter.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'id_code', as: 'store' });
Store.hasMany(FinCostCenter, { foreignKey: 'store_id', sourceKey: 'id_code', as: 'finCostCenters' });

FinancialTransaction.belongsTo(FinCostCenter, { foreignKey: 'cost_center_id', targetKey: 'id_code', as: 'finCostCenter' });
FinCostCenter.hasMany(FinancialTransaction, { foreignKey: 'cost_center_id', sourceKey: 'id_code', as: 'transactions' });

// FinTag associations
FinTag.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'id_code', as: 'store' });
Store.hasMany(FinTag, { foreignKey: 'store_id', sourceKey: 'id_code', as: 'finTags' });

FinancialTransaction.belongsToMany(FinTag, {
  through: 'financial_transaction_tags',
  foreignKey: 'transaction_id',
  otherKey: 'tag_id',
  sourceKey: 'id_code',
  targetKey: 'id_code',
  as: 'tags'
});
FinTag.belongsToMany(FinancialTransaction, {
  through: 'financial_transaction_tags',
  foreignKey: 'tag_id',
  otherKey: 'transaction_id',
  sourceKey: 'id_code',
  targetKey: 'id_code',
  as: 'transactions'
});

// FinRecurrence associations
FinRecurrence.hasMany(FinancialTransaction, { foreignKey: 'recurrence_id', sourceKey: 'id_code', as: 'transactions' });
FinancialTransaction.belongsTo(FinRecurrence, { foreignKey: 'recurrence_id', targetKey: 'id_code', as: 'recurrence' });

FinRecurrence.belongsTo(Store, { foreignKey: 'store_id', targetKey: 'id_code', as: 'store' });
Store.hasMany(FinRecurrence, { foreignKey: 'store_id', sourceKey: 'id_code', as: 'finRecurrences' });

FinRecurrence.belongsTo(FinCategory, { foreignKey: 'category_id', targetKey: 'id_code', as: 'finCategory' });
FinCategory.hasMany(FinRecurrence, { foreignKey: 'category_id', sourceKey: 'id_code', as: 'recurrences' });

FinRecurrence.belongsTo(FinCostCenter, { foreignKey: 'cost_center_id', targetKey: 'id_code', as: 'finCostCenter' });
FinCostCenter.hasMany(FinRecurrence, { foreignKey: 'cost_center_id', sourceKey: 'id_code', as: 'recurrences' });

FinRecurrence.belongsTo(Party, { foreignKey: 'party_id', targetKey: 'id_code', as: 'party' });
Party.hasMany(FinRecurrence, { foreignKey: 'party_id', sourceKey: 'id_code', as: 'recurrences' });

// EventJamMusicSuggestion associations
EventJamMusicSuggestion.belongsTo(Event, { foreignKey: 'event_id', as: 'event' });
Event.hasMany(EventJamMusicSuggestion, { foreignKey: 'event_id', as: 'musicSuggestions' });

EventJamMusicSuggestion.belongsTo(User, { foreignKey: 'created_by_user_id', as: 'creator' });
User.hasMany(EventJamMusicSuggestion, { foreignKey: 'created_by_user_id', as: 'createdMusicSuggestions' });

EventJamMusicSuggestion.belongsTo(EventGuest, { foreignKey: 'created_by_guest_id', as: 'guestCreator' });
EventGuest.hasMany(EventJamMusicSuggestion, { foreignKey: 'created_by_guest_id', as: 'createdMusicSuggestions' });

EventJamMusicSuggestion.hasMany(EventJamMusicSuggestionParticipant, { foreignKey: 'music_suggestion_id', as: 'participants' });
EventJamMusicSuggestionParticipant.belongsTo(EventJamMusicSuggestion, { foreignKey: 'music_suggestion_id', as: 'suggestion' });

EventJamMusicSuggestionParticipant.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
User.hasMany(EventJamMusicSuggestionParticipant, { foreignKey: 'user_id', as: 'musicSuggestionParticipations' });

EventJamMusicSuggestionParticipant.belongsTo(EventGuest, { foreignKey: 'guest_id', as: 'guest' });
EventGuest.hasMany(EventJamMusicSuggestionParticipant, { foreignKey: 'guest_id', as: 'musicSuggestionParticipations' });

module.exports = {
  sequelize,
  Plan,
  Store,
  User,
  StoreUser,
  Product,
  Order,
  OrderItem,
  PixPayment,
  Message,
  FootballTeam,
  TokenBlocklist,
  StoreSchedule,
  FinancialTransaction,
  FinancialCommission,
  BankAccount,
  Event
  ,EventQuestion
  ,EventResponse
  ,EventAnswer
  ,EventGuest
  ,EventJam
  ,EventJamSong
  ,EventJamSongInstrumentSlot
  ,EventJamSongCandidate
  ,EventJamSongRating
  ,Party
  ,FinCategory
  ,FinCostCenter
  ,FinTag
  ,FinRecurrence
  ,SysModule
  ,EventJamMusicSuggestion
  ,EventJamMusicSuggestionParticipant
  ,EventJamMusicCatalog
  ,Organization
  ,StoreMember
  ,StoreInvite
};
