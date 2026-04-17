# vnw-resgate-api

API de CRUD de Usuários básica.  
Projetada como base de estudo para alunos — simples, segura e pronta para expandir.

---

## 🛡️ Recursos de Segurança

### UUID como Identificador Público
Todos os registros possuem um campo `id_code` (UUID v4) que é o **único identificador exposto nas respostas da API**. O `id` sequencial interno do banco de dados **nunca é retornado** ao cliente, evitando:
- Enumeração de registros por atacantes
- Vazamento da quantidade de registros no sistema
- Ataques de previsão de ID (IDOR)

### Autenticação via JWT (JSON Web Token)
- Toda rota protegida exige um token JWT válido no header `Authorization: Bearer <token>`
- O middleware `authenticateToken` verifica a validade do token em **cada requisição**
- Tokens possuem **prazo de expiração** configurável (padrão: 24h)
- Cache em memória no middleware evita consultas desnecessárias ao banco

### Token Blocklist (Logout Seguro)
- O endpoint `POST /auth/logout` invalida o token atual, adicionando-o à **blocklist no banco de dados**
- Mesmo que o token ainda não tenha expirado, ele é **rejeitado imediatamente** após o logout
- Cache em memória da blocklist (TTL: 60s) para performance

### Controle de Acesso por Roles
O sistema implementa 5 níveis de acesso hierárquicos:
| Role | Nível | Descrição |
|------|-------|-----------|
| `master` | 🔴 Máximo | Super administrador — acesso total |
| `admin` | 🟠 Alto | Administrador — gerencia usuários e dados |
| `manager` | 🟡 Médio | Gerente — acesso administrativo limitado |
| `volunteer` | 🟢 Básico | Voluntário — acesso às funções operacionais |
| `people` | 🔵 Padrão | Cidadão — perfil padrão no cadastro |

### Proteções Adicionais
- **Helmet.js** — Headers HTTP de segurança contra XSS, clickjacking, etc.
- **Rate Limiting** — Limite de 1000 requisições por IP a cada 15 minutos
- **Speed Limiting** — Adiciona delay progressivo após 500 requisições
- **CORS** — Configurável via variável de ambiente
- **Bcrypt (12 rounds)** — Senhas nunca armazenadas em texto puro

---

## 🔌 Integrações Prontas

### Login com Google (Firebase)
A API está preparada para autenticação via Google OAuth usando Firebase Admin SDK.  
Para ativar, basta configurar no `.env`:
```env
FIREBASE_PROJECT_ID=seu_project_id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@seu_project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```
O endpoint `POST /api/v1/auth/google` recebe o `idToken` do Firebase no frontend e:
1. Verifica o token com o Firebase Admin SDK
2. Cria o usuário automaticamente se não existir
3. Vincula a conta Google se o email já existir
4. Retorna o token JWT da API

### Upload de Arquivos (Google Drive)
Sistema completo de upload de arquivos para o Google Drive via OAuth2:
- **Upload** — `POST /api/v1/uploads` recebe um arquivo via `multipart/form-data`
- **Proxy** — `GET /api/v1/files/:id` serve o arquivo diretamente, evitando problemas de CORS
- Organização automática em pastas no Drive
- Suporte a imagens, PDFs e outros tipos de arquivo

Para ativar, configure no `.env`:
```env
GOOGLE_DRIVE_CLIENT_ID=seu_client_id
GOOGLE_DRIVE_CLIENT_SECRET=seu_client_secret
GOOGLE_DRIVE_REDIRECT_URI=https://sua-api/api/v1/uploads/oauth/callback
GOOGLE_DRIVE_REFRESH_TOKEN=seu_refresh_token
GOOGLE_DRIVE_FOLDER_ID=id_da_pasta_raiz
```

### Geração de PDFs
Serviço utilitário (`pdfService.js`) para gerar PDFs a partir de HTML usando Puppeteer.  
Exemplo de uso em uma rota customizada:
```javascript
const pdfService = require('./services/pdfService');
const buffer = await pdfService.generatePdf('<h1>Relatório</h1><p>Conteúdo...</p>');
res.setHeader('Content-Type', 'application/pdf');
res.send(buffer);
```

---

## 📚 Tecnologias

| Tecnologia | Versão | Descrição |
|------------|--------|-----------|
| Node.js | 20+ | Runtime JavaScript |
| Express | 4.x | Framework HTTP |
| Sequelize | 6.x | ORM (PostgreSQL / MySQL) |
| JWT | 9.x | Autenticação por token |
| Bcrypt | 2.x | Hash de senhas |
| Firebase Admin | 13.x | Login com Google |
| Multer | 1.x | Upload de arquivos |
| Puppeteer | 24.x | Geração de PDFs |
| Swagger | 6.x | Documentação interativa |

---

## 🚀 Setup Rápido

```bash
# 1. Clonar o repositório
git clone https://github.com/Davisvasconcellos/vnw-resgate-api.git
cd vnw-resgate-api

# 2. Instalar dependências
npm install

# 3. Configurar variáveis de ambiente
cp env.example .env
# Edite o .env com suas credenciais do banco

# 4. Criar as tabelas no banco de dados
# Opção A: Via Sequelize Migration
npx sequelize-cli db:migrate

# Opção B: Via SQL direto (veja seção Schema abaixo)

# 5. Iniciar o servidor
npm run dev

# 6. Acessar documentação
# http://localhost:4000/api-docs
```

---

## 📋 Endpoints

### Auth (`/api/v1/auth`)
| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `POST` | `/register` | Cadastro público (role padrão: `people`) | ❌ |
| `POST` | `/login` | Login com email e senha | ❌ |
| `POST` | `/google` | Login com Google (Firebase) | ❌ |
| `GET` | `/me` | Dados do usuário logado | 🔒 Token |
| `POST` | `/refresh` | Renovar token JWT antes de expirar | 🔒 Token |
| `POST` | `/logout` | Invalidar token (blocklist) | 🔒 Token |

### Users (`/api/v1/users`)
| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `GET` | `/` | Listar todos (paginado, com busca) | 🔒 Admin |
| `GET` | `/:id` | Obter por ID ou UUID (`id_code`) | 🔒 Admin |
| `POST` | `/` | Criar novo usuário com role definida | 🔒 Admin |
| `PUT` | `/me` | Atualizar próprio perfil | 🔒 Token |
| `PATCH` | `/me` | Atualizar avatar | 🔒 Token |
| `PUT` | `/:id` | Atualizar qualquer usuário | 🔒 Admin |
| `POST` | `/:id_code/reset-password` | Resetar senha de um usuário | 🔒 Admin |
| `DELETE` | `/:id` | Deletar usuário | 🔒 Admin |

### Upload/Files
| Método | Rota | Descrição | Auth |
|--------|------|-----------|------|
| `POST` | `/api/v1/uploads` | Upload de arquivo para Google Drive | ❌ |
| `GET` | `/api/v1/files/:id` | Proxy de exibição de arquivo | ❌ |

### Documentação
| Rota | Descrição |
|------|-----------|
| `/api-docs` | Swagger UI — documentação interativa |

---

## 🗄️ Schema do Banco de Dados (SQL)

Para criar as tabelas manualmente no seu servidor PostgreSQL, execute o SQL abaixo.

> **⚠️ IMPORTANTE**: Esse script cria APENAS as tabelas da API. Se o banco já tiver outras tabelas, elas NÃO serão afetadas.

```sql
-- ==========================================
-- TABELA: plans
-- ==========================================
CREATE TABLE IF NOT EXISTS plans (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price DECIMAL(10, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- TIPOS ENUM
-- ==========================================
DO $$ BEGIN
  CREATE TYPE enum_users_role AS ENUM ('master', 'admin', 'manager', 'volunteer', 'people');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE enum_users_status AS ENUM ('active', 'inactive', 'pending_verification', 'banned');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ==========================================
-- TABELA: users
-- ==========================================
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE,
  phone VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  role enum_users_role NOT NULL DEFAULT 'people',
  google_id VARCHAR(255) UNIQUE,
  google_uid VARCHAR(255) UNIQUE,
  avatar_url VARCHAR(500),
  birth_date DATE,
  address_street VARCHAR(255),
  address_number VARCHAR(20),
  address_complement VARCHAR(255),
  address_neighborhood VARCHAR(255),
  address_city VARCHAR(255),
  address_state VARCHAR(2),
  address_zip_code VARCHAR(10),
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  status enum_users_status NOT NULL DEFAULT 'active',
  plan_id INTEGER REFERENCES plans(id) ON UPDATE CASCADE ON DELETE SET NULL,
  plan_start DATE,
  plan_end DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- TABELA: token_blocklist
-- ==========================================
CREATE TABLE IF NOT EXISTS token_blocklist (
  id SERIAL PRIMARY KEY,
  token VARCHAR(512) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==========================================
-- TABELA DE CONTROLE DO SEQUELIZE (opcional)
-- ==========================================
CREATE TABLE IF NOT EXISTS "SequelizeMeta" (
  name VARCHAR(255) NOT NULL UNIQUE PRIMARY KEY
);
```

---

## 📁 Estrutura do Projeto

```
vnw-resgate-api/
├── src/
│   ├── config/
│   │   ├── config.js          # Config Sequelize CLI
│   │   ├── database.js        # Conexão com o banco
│   │   └── firebaseAdmin.js   # Firebase Admin SDK
│   ├── middlewares/
│   │   ├── auth.js            # authenticateToken + requireRole
│   │   └── errorHandler.js    # Tratamento global de erros
│   ├── migrations/
│   │   └── 20260416...-create-users-plans-token-blocklist.js
│   ├── models/
│   │   ├── User.js            # Modelo de usuário
│   │   ├── Plan.js            # Modelo de plano
│   │   ├── TokenBlocklist.js  # Modelo de tokens invalidados
│   │   └── index.js           # Associações
│   ├── routes/
│   │   ├── auth.js            # Login, registro, Google, logout
│   │   ├── users.js           # CRUD de usuários
│   │   ├── upload.js          # Upload para Google Drive
│   │   ├── files.js           # Proxy de arquivos
│   │   └── pdf.js             # Geração de PDFs
│   ├── services/
│   │   └── pdfService.js      # Geração de PDFs
│   ├── utils/
│   │   └── requestContext.js  # Contexto de requisição
│   └── server.js              # Entry point
├── .env.example
├── .gitignore
├── .sequelizerc
├── docker-compose.yml         # MySQL local (opcional)
├── package.json
└── README.md
```

---

## 📝 Variáveis de Ambiente

| Variável | Obrigatória | Descrição |
|----------|:-----------:|-----------|
| `DATABASE_URL` | ✅ | URL de conexão PostgreSQL |
| `JWT_SECRET` | ✅ | Chave secreta para assinar tokens JWT |
| `PORT` | ❌ | Porta do servidor (padrão: 4000) |
| `NODE_ENV` | ❌ | Ambiente: `development` ou `production` |
| `FIREBASE_PROJECT_ID` | ❌ | ID do projeto Firebase (login Google) |
| `FIREBASE_CLIENT_EMAIL` | ❌ | Email do service account |
| `FIREBASE_PRIVATE_KEY` | ❌ | Chave privada do service account |
| `GOOGLE_DRIVE_CLIENT_ID` | ❌ | Client ID OAuth2 (upload) |
| `GOOGLE_DRIVE_CLIENT_SECRET` | ❌ | Client Secret OAuth2 |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | ❌ | Refresh token OAuth2 |
| `GOOGLE_DRIVE_FOLDER_ID` | ❌ | ID da pasta raiz no Drive |

---

**Desenvolvido por Davis Vasconcellos** 🚀
