# vnw-resgate-api

API de CRUD de Usuários para a plataforma VNW Resgate.

## Tecnologias
- Node.js + Express
- Sequelize ORM (PostgreSQL / MySQL)
- JWT Authentication
- Google OAuth (Firebase)
- Upload de arquivos (Google Drive)
- Swagger API Docs

---

## Setup Rápido

```bash
# 1. Clonar o repositório
git clone https://github.com/Davisvasconcellos/vnw-resgate-api.git
cd vnw-resgate-api

# 2. Instalar dependências
npm install

# 3. Configurar variáveis de ambiente
cp env.example .env
# Edite o .env com suas credenciais

# 4. Criar as tabelas no banco de dados
# Opção A: Via Sequelize Migration
npx sequelize-cli db:migrate

# Opção B: Via SQL direto (veja seção abaixo)

# 5. Iniciar o servidor
npm run dev
```

---

## Schema do Banco de Dados (SQL)

Para criar as tabelas manualmente no seu banco PostgreSQL, execute o SQL abaixo.
> **⚠️ ATENÇÃO**: Esse script cria APENAS as tabelas da API. Se o banco já tiver outras tabelas, elas NÃO serão afetadas.

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

## Endpoints

### Auth (`/api/v1/auth`)
| Método | Rota | Descrição | Autenticação |
|--------|------|-----------|--------------|
| `POST` | `/register` | Cadastro público | ❌ |
| `POST` | `/login` | Login email/senha | ❌ |
| `POST` | `/google` | Login Google (Firebase) | ❌ |
| `GET` | `/me` | Dados do usuário logado | ✅ Token |
| `POST` | `/refresh` | Renovar token JWT | ✅ Token |
| `POST` | `/logout` | Logout | ✅ Token |

### Users (`/api/v1/users`)
| Método | Rota | Descrição | Autenticação |
|--------|------|-----------|--------------|
| `GET` | `/` | Listar todos (paginado + search) | ✅ Admin |
| `GET` | `/:id` | Obter por ID ou UUID | ✅ Admin |
| `POST` | `/` | Criar novo usuário | ✅ Admin |
| `PUT` | `/me` | Atualizar próprio perfil | ✅ Token |
| `PATCH` | `/me` | Atualizar avatar | ✅ Token |
| `PUT` | `/:id` | Atualizar usuário (admin) | ✅ Admin |
| `POST` | `/:id_code/reset-password` | Reset de senha | ✅ Admin |
| `DELETE` | `/:id` | Deletar usuário | ✅ Admin |

### Upload/Files
| Método | Rota | Descrição | Autenticação |
|--------|------|-----------|--------------|
| `POST` | `/api/v1/uploads` | Upload de arquivo (Google Drive) | ❌ |
| `GET` | `/api/v1/files/:id` | Proxy de arquivo | ❌ |

### Documentação Swagger
Acesse `/api-docs` para ver a documentação interativa da API.

---

## Roles do Sistema
| Role | Descrição |
|------|-----------|
| `master` | Super administrador (acesso total) |
| `admin` | Administrador |
| `manager` | Gerente |
| `volunteer` | Voluntário |
| `people` | Pessoa/Cidadão (padrão no registro) |

---

## Variáveis de Ambiente

Veja o arquivo `env.example` para a lista completa. As principais são:

| Variável | Descrição |
|----------|-----------|
| `DATABASE_URL` | URL de conexão PostgreSQL |
| `JWT_SECRET` | Chave secreta para tokens JWT |
| `PORT` | Porta do servidor (padrão: 4000) |
| `FIREBASE_*` | Credenciais Firebase para login Google |
| `GOOGLE_DRIVE_*` | Credenciais OAuth2 para upload de arquivos |
