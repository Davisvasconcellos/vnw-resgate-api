# 🛡️ VNW Resgate — API de Missão Crítica (V1.0)

O motor do ecossistema **VNW Resgate**, uma API robusta desenvolvida em Node.js com Sequelize e PostgreSQL, projetada para coordenar operações de salvamento, gestão de abrigos e logística de voluntariado em tempo real.

---

## 🏗️ Arquitetura e Inteligência Operacional

### 1. 📍 Geolocalização via Haversine (Native SQL)
A API processa buscas espaciais complexas diretamente no banco de dados. Utilizamos a **Fórmula de Haversine** para filtrar pedidos de ajuda e abrigos por raio de distância (`radiusKm`), garantindo que os voluntários vejam apenas o que podem atender.

### 2. 🏠 Hooks de Impacto (Shelter Sync)
Implementamos uma automação logística vital: ao concluir um resgate com destino a um abrigo, o sistema recalcula automaticamente a **taxa de ocupação** do local, criando um registro de entrada (`ShelterEntry`) sem intervenção manual.

### 3. 🛡️ Segurança por Obscuridade & JWT
*   **UUID v4:** O campo `id_code` é a única identidade exposta publicamente. IPs sequenciais são protegidos e nunca retornados.
*   **Auth Híbrida:** Suporte nativo para email/senha e **Google Login (Firebase Admin SDK)**.
*   **JWT Life-Cycle:** Sistema completo de tokens com Refresh Token e invalidação de Logout.
*   **Hierarquia de Roles:** Sistema granular de permissões (`master`, `admin`, `manager`, `volunteer`, `people`).

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

## 🗄️ SQL Schema (V1.0 Final)

Use o script abaixo para inicializar seu banco de dados PostgreSQL com a estrutura operacional completa:

```sql
-- TABELA PRINCIPAL DE PEDIDOS DE AJUDA
CREATE TABLE IF NOT EXISTS help_requests (
  id SERIAL PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id),
  accepted_by INTEGER REFERENCES users(id),
  type VARCHAR(50) NOT NULL, -- rescue, medical, food, transport, boat, shelter
  status VARCHAR(50) DEFAULT 'pending', -- pending, attending, resolved
  urgency VARCHAR(50) DEFAULT 'high',
  people_count INTEGER DEFAULT 1,
  address TEXT,
  lat DECIMAL(10, 7),
  lng DECIMAL(10, 7),
  description TEXT,
  volunteer_message TEXT,
  is_verified BOOLEAN DEFAULT FALSE,
  device_id VARCHAR(255), -- Fingerprint para offline sync
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- TABELA DE ABRIGOS E LOGÍSTICA
CREATE TABLE IF NOT EXISTS shelters (
  id SERIAL PRIMARY KEY,
  id_code VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  capacity INTEGER DEFAULT 0,
  occupied INTEGER DEFAULT 0,
  has_water BOOLEAN DEFAULT FALSE,
  has_energy BOOLEAN DEFAULT FALSE,
  accepts_pets BOOLEAN DEFAULT FALSE,
  lat DECIMAL(10, 7),
  lng DECIMAL(10, 7),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- CONSULTE A PASTA /src/migrations PARA O SCHEMA COMPLETO
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
