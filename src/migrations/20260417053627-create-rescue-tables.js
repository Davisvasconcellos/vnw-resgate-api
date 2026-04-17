'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ==========================================
    // 1. HELP REQUESTS
    // ==========================================
    await queryInterface.createTable('help_requests', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      id_code: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true
      },
      user_id: { // Quem pediu ajuda (pode ser null se anônimo no frontend ou sempre obrigatorio, assumiremos nullable por flexibilidade)
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      accepted_by: { // Voluntario que assumiu/aceitou
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      type: {
        type: Sequelize.ENUM('rescue', 'shelter', 'medical', 'food', 'transport', 'boat'),
        allowNull: false
      },
      status: {
        type: Sequelize.ENUM('pending', 'viewed', 'attending', 'resolved'),
        allowNull: false,
        defaultValue: 'pending'
      },
      urgency: {
        type: Sequelize.ENUM('high', 'medium', 'low'),
        allowNull: false,
        defaultValue: 'high'
      },
      people_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1
      },
      address: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      lat: {
        type: Sequelize.DECIMAL(10, 7),
        allowNull: true
      },
      lng: {
        type: Sequelize.DECIMAL(10, 7),
        allowNull: true
      },
      photo_url: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      reporter_name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      reporter_phone: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    // ==========================================
    // 2. MISSING PERSONS
    // ==========================================
    await queryInterface.createTable('missing_persons', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      id_code: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      age: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      status: {
        type: Sequelize.ENUM('missing', 'found'),
        allowNull: false,
        defaultValue: 'missing'
      },
      last_seen_location: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      reporter_name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      reporter_phone: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      photo_url: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    // ==========================================
    // 3. SHELTERS
    // ==========================================
    await queryInterface.createTable('shelters', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      id_code: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true
      },
      user_id: { // Gestor do abrigo
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      address: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      capacity: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      occupied: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      phone: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      reference_point: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      lat: {
        type: Sequelize.DECIMAL(10, 7),
        allowNull: true
      },
      lng: {
        type: Sequelize.DECIMAL(10, 7),
        allowNull: true
      },
      has_water: { type: Sequelize.BOOLEAN, defaultValue: false },
      has_food: { type: Sequelize.BOOLEAN, defaultValue: false },
      has_bath: { type: Sequelize.BOOLEAN, defaultValue: false },
      has_energy: { type: Sequelize.BOOLEAN, defaultValue: false },
      accepts_pets: { type: Sequelize.BOOLEAN, defaultValue: false },
      has_medical: { type: Sequelize.BOOLEAN, defaultValue: false },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    // ==========================================
    // 4. SHELTER ENTRIES
    // ==========================================
    await queryInterface.createTable('shelter_entries', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      id_code: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true
      },
      shelter_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'shelters', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      phone: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      people_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1
      },
      status: {
        type: Sequelize.ENUM('request', 'incoming', 'present', 'left'),
        allowNull: false,
        defaultValue: 'request'
      },
      assume_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    // ==========================================
    // 5. VOLUNTEER PROFILES
    // ==========================================
    await queryInterface.createTable('volunteer_profiles', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      id_code: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      offer_type: {
        type: Sequelize.ENUM('transport', 'boat', 'volunteer'),
        allowNull: false
      },
      vehicle_type: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      seats_available: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      region: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      availability: {
        type: Sequelize.ENUM('full', 'morning', 'afternoon', 'night'),
        allowNull: true
      },
      skills: {
        type: Sequelize.JSON, 
        allowNull: true
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });

    // ==========================================
    // 6. SHELTER VOLUNTEERS
    // ==========================================
    await queryInterface.createTable('shelter_volunteers', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      shelter_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'shelters', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      status: {
        type: Sequelize.ENUM('pending', 'accepted'),
        allowNull: false,
        defaultValue: 'pending'
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()')
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('shelter_volunteers');
    await queryInterface.dropTable('volunteer_profiles');
    await queryInterface.dropTable('shelter_entries');
    await queryInterface.dropTable('shelters');
    await queryInterface.dropTable('missing_persons');
    await queryInterface.dropTable('help_requests');
    
    // Deletar os tipos ENUM no postgres para evitar colisão futura, se possível
    const dialect = queryInterface.sequelize.options.dialect;
    if (dialect === 'postgres') {
      try {
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_help_requests_type CASCADE;`);
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_help_requests_status CASCADE;`);
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_help_requests_urgency CASCADE;`);
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_missing_persons_status CASCADE;`);
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_shelter_entries_status CASCADE;`);
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_volunteer_profiles_offer_type CASCADE;`);
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_volunteer_profiles_availability CASCADE;`);
        await queryInterface.sequelize.query(`DROP TYPE IF EXISTS enum_shelter_volunteers_status CASCADE;`);
      } catch(e) { }
    }
  }
};
