# 🛡️ VNW Resgate — API de Missão Crítica (V1.0)

O motor do ecossistema **VNW Resgate**, uma API robusta desenvolvida em Node.js com Sequelize e PostgreSQL, projetada para coordenar operações de salvamento, gestão de abrigos e logística de voluntariado em tempo real.

---

## 🏗️ Arquitetura e Inteligência Operacional

### 1. 📍 Geolocalização via Haversine (Native SQL)
A API processa buscas espaciais complexas diretamente no banco de dados. Utilizei a **Fórmula de Haversine** para filtrar pedidos de ajuda e abrigos por raio de distância (`radiusKm`), garantindo que os voluntários vejam apenas o que podem atender.

### 2. 🏠 Hooks de Impacto (Shelter Sync)
Implementei uma automação logística vital: ao concluir um resgate com destino a um abrigo, o sistema recalcula automaticamente a **taxa de ocupação** do local, criando um registro de entrada (`ShelterEntry`) sem intervenção manual.

### 3. 🛡️ Segurança por Obscuridade & JWT
*   **UUID v4:** O campo `id_code` é a única identidade exposta publicamente. IPs sequenciais são protegidos e nunca retornados.
*   **Auth Híbrida:** Suporte nativo para email/senha e **Google Login (Firebase Admin SDK)**.
*   **JWT Life-Cycle:** Sistema completo de tokens com Refresh Token e invalidação de Logout.
*   **Hierarquia de Roles (V2.0):** Sistema granular de permissões incluindo perfis de resgate (`civilian`, `shelter`, `transport`, `boat`, `volunteer`, `people`, `admin`, `master`).
*   **Onboarding Inteligente:** Suporte nativo para redirecionamento condicional. A API sinaliza ao frontend a necessidade de completude de perfil (endereço/coordenadas) para habilitar buscas por proximidade.

---

## ⚡ Power Features (Recursos Avançados)

O ecossistema VNW Resgate vai além do CRUD básico, integrando serviços de nível empresarial:

### 📄 Gerador de PDFs (Puppeteer Engine)
Sistema utilitário para conversão de dados operacionais em documentos PDF formatados. Ideal para emissão de relatórios de abrigos ou listas de passageiros em resgates.

### 📂 Google Drive Integration
Integração nativa com a API do Google Drive para armazenamento de evidências fotográficas:
*   **Automated Folders**: Criação dinâmica de estrutura de pastas (Ex: `pedidos/fotos/2024`).
*   **Secure Proxy**: Os arquivos são servidos através de um proxy na API, garantindo conformidade com políticas de CORS e segurança.

### 🔑 Google Auth & Auto-User Provisioning
Fluxo automatizado de autenticação social:
*   Se o usuário fizer login via Google e não existir no sistema, a API **cria automaticamente** o perfil, baixa o avatar e vincula as credenciais com segurança.

---

## 📋 Módulos e Endpoints
Temos a documentação completa da API no swagger : http://localhost:4000/api-docs
E por medida de segurança, só abre em dev. 

Mas como estamos em dev com a aplicação do **VNW Resgate**, vou deixar aqui os principais endpoints:

### 🆘 Salvamento (`/api/v1/requests`)
*   `POST /` : Criação de pedidos de resgate (Suporta Fingerprint/DeviceID).
*   `GET /` : Busca inteligente por raio km e tipo (SOS, Médico, Transporte, Barco).
*   `PUT /:id_code/status` : Fluxo de aceite por voluntários com suporte a mensagens de apoio.

### 🏛️ Abrigos (`/api/v1/shelters`)
*   `GET /` : Lista de abrigos com indicadores de suprimentos (água, luz, pet-friendly).
*   `POST /:id_code/entries` : Registro de acolhimento de pessoas.
*   `GET /:id_code/entries` : Monitoramento em tempo real de quem está no abrigo.

### 🛡️ Voluntariado (`/api/v1/volunteers`)
*   `GET /tasks` : Dashboard unificado para o voluntário (Missões aceitas + Convites).
*   `POST /profile` : Cadastro de competências (Barco, Jet-ski, Primeiros Socorros).

---

## 🗄️ SQL Schema (Full MySQL/MariaDB)

Use o script abaixo para inicializar seu banco de dados MySQL/MariaDB com a estrutura operacional completa. Este script contém todas as tabelas, relacionamentos e enums necessários:

```sql
-- 1. PLANOS DE ACESSO
CREATE TABLE IF NOT EXISTS plans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. USUÁRIOS
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(20),
  password_hash VARCHAR(255),
  role ENUM('master', 'admin', 'manager', 'volunteer', 'people', 'civilian', 'shelter', 'transport', 'boat') DEFAULT 'civilian',
  google_id VARCHAR(255) UNIQUE,
  google_uid VARCHAR(255) UNIQUE,
  avatar_url VARCHAR(500),
  birth_date DATE,
  address_street TEXT,
  address_number VARCHAR(20),
  address_complement TEXT,
  address_neighborhood VARCHAR(255),
  address_city VARCHAR(255),
  address_state VARCHAR(2),
  address_zip_code VARCHAR(10),
  email_verified BOOLEAN DEFAULT FALSE,
  status ENUM('active', 'inactive', 'pending_verification', 'banned') DEFAULT 'active',
  plan_id INT,
  plan_start DATE,
  plan_end DATE,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  use_default_location BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL
);

-- 3. TOKEN BLOCKLIST (Logout Security)
CREATE TABLE IF NOT EXISTS token_blocklist (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token VARCHAR(512) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 4. PEDIDOS DE AJUDA (HELP REQUESTS)
CREATE TABLE IF NOT EXISTS help_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE NOT NULL,
  user_id INT,
  accepted_by INT,
  shelter_id INT,
  type ENUM('rescue', 'shelter', 'medical', 'food', 'transport', 'boat') NOT NULL,
  status ENUM('pending', 'viewed', 'attending', 'resolved') DEFAULT 'pending',
  urgency ENUM('high', 'medium', 'low') DEFAULT 'high',
  people_count INT DEFAULT 1,
  address TEXT,
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  photo_url VARCHAR(500),
  reporter_name VARCHAR(255),
  reporter_phone VARCHAR(20),
  volunteer_message TEXT,
  is_verified BOOLEAN DEFAULT FALSE,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 5. PESSOAS DESAPARECIDAS
CREATE TABLE IF NOT EXISTS missing_persons (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE NOT NULL,
  user_id INT,
  name VARCHAR(255) NOT NULL,
  age INT,
  status ENUM('missing', 'found') DEFAULT 'missing',
  last_seen_location VARCHAR(255),
  description TEXT,
  reporter_name VARCHAR(255),
  reporter_phone VARCHAR(20),
  photo_url VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 6. ABRIGOS (SHELTERS)
CREATE TABLE IF NOT EXISTS shelters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE NOT NULL,
  user_id INT,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  capacity INT,
  occupied INT DEFAULT 0,
  phone VARCHAR(20),
  reference_point VARCHAR(255),
  lat DECIMAL(10, 8),
  lng DECIMAL(11, 8),
  has_water BOOLEAN DEFAULT FALSE,
  has_food BOOLEAN DEFAULT FALSE,
  has_bath BOOLEAN DEFAULT FALSE,
  has_energy BOOLEAN DEFAULT FALSE,
  accepts_pets BOOLEAN DEFAULT FALSE,
  has_medical BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 7. ENTRADAS EM ABRIGOS (LOG DE OCUPAÇÃO)
CREATE TABLE IF NOT EXISTS shelter_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE NOT NULL,
  shelter_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  people_count INT DEFAULT 1,
  status ENUM('request', 'incoming', 'present', 'left') DEFAULT 'request',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (shelter_id) REFERENCES shelters(id) ON DELETE CASCADE
);

-- 8. PERFIS DE VOLUNTÁRIOS (HABILIDADES)
CREATE TABLE IF NOT EXISTS volunteer_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE NOT NULL,
  user_id INT NOT NULL,
  offer_type ENUM('transport', 'boat', 'volunteer') NOT NULL,
  vehicle_type VARCHAR(100),
  seats_available INT,
  region VARCHAR(255),
  availability ENUM('full', 'morning', 'afternoon', 'night'),
  skills JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 9. EQUIPE DE ABRIGOS (VÍNCULO VOLUNTÁRIO-ABRIGO)
CREATE TABLE IF NOT EXISTS shelter_volunteers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  shelter_id INT NOT NULL,
  status ENUM('pending', 'accepted') DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (shelter_id) REFERENCES shelters(id) ON DELETE CASCADE
);
```

---

## 🚀 Setup Rápido (Replicação)

### 💻 Local
```bash
# 1. Instalar dependências
npm install

# 2. Configurar o Banco de Dados (.env)
cp env.example .env

# 3. Inicialização Automatizada
# rode o comando abaixo que o script já cria as tabelas para você. só precisa configurar o .env com os dados do postgree
npm run db:setup

# 4. Iniciar o Motor
npm run dev
```

### ☁️ Produção (Render)
Para o deploy no **Render**:
1.  **Variáveis de Ambiente**: Configure todas as variáveis presentes no `.env.example` diretamente no painel do Render (*Environment Variables*).
2.  **Firebase JSON**: A `FIREBASE_PRIVATE_KEY` deve conter as quebras de linha `\n` corretamente para ser interpretada pelo Admin SDK.
3.  **Database**: Utilize um banco de dados gerenciado (como o Render PostgreSQL) e insira a URL na variável `DATABASE_URL`.

---

## 🔗 Links Oficiais para Configuração
*   **Firebase Admin SDK**: [Firebase Console](https://console.firebase.google.com/) -> Configurações do Projeto -> Contas de Serviço -> Gerar nova chave privada.
*   **Google Drive API**: [Google Cloud Console](https://console.cloud.google.com/) -> APIs e Serviços -> Ativar 'Google Drive API' e criar 'ID do cliente OAuth 2.0'.

### 🗃️ Guia de Banco de Dados
O comando `npm run db:setup` garante que:
1. Todas as tabelas operacionais (Pedidos, Abrigos, Voluntários) sejam criadas. (Mamão com açucar)
2. Os **Planos de Acesso** fundamentais sejam inseridos via `Seeders`. (admin, master, voluntário)

### 📝 Variáveis de Ambiente Críticas

| Variável | Uso |
|----------|-----|
| `JWT_SECRET` | Assinatura dos tokens de segurança |
| `DATABASE_URL` | Conexão com PostgreSQL |
| `FIREBASE_*` | Credenciais para Login com Google |
| `GOOGLE_DRIVE_*` | Credenciais OAuth2 para Upload de fotos |

---

**VNW Resgate API** — *Onde a tecnologia encontra a esperança.* 🚀🛡️
