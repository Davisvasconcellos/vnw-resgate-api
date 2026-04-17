# Roteiro para Construção da API (VNW Resgate)

Olá! Estamos construindo a API para o projeto **VNW Resgate**. Já desenvolvemos toda a interface (Frontend) e agora precisamos criar as tabelas, modelos (Sequelize) e endpoints para suportar as funcionalidades. 

Abaixo está o mapeamento detalhado das entidades e rotas que precisamos. Por favor, crie as *Migrations*, *Models*, *Controllers* e *Routes* correspondentes.

---

## 1. Atualização da Tabela de Usuários (Roles)

No frontend, identificamos papéis específicos que um usuário pode assumir após o *onboarding*.
Precisamos atualizar o ENUM de `role` na tabela `users` (ou criar uma tabela de perfis) para suportar:
- `civilian` (cidadão comum)
- `shelter` (gestor de abrigo)
- `transport` (motorista voluntário)
- `boat` (piloto de barco voluntário)
- `volunteer` (voluntário em solo)

---

## 2. Tabelas e Modelos (Schema)

Por favor, crie as migrations e models para as seguintes entidades:

### A. `help_requests` (Pedidos de Ajuda / Resgate)
- `id` (UUID ou Serial com id_code)
- `user_id` (FK para Users - quem solicitou)
- `type` (ENUM: 'rescue', 'shelter', 'medical', 'food', 'transport', 'boat')
- `status` (ENUM: 'pending', 'viewed', 'attending', 'resolved')
- `urgency` (ENUM: 'high', 'medium', 'low')
- `people_count` (Integer - quantidade de pessoas)
- `address` (Text)
- `lat`, `lng` (Decimal/Float)
- `photo_url` (String)
- `reporter_name` (String)
- `reporter_phone` (String)

### B. `missing_persons` (Pessoas Desaparecidas)
- `id` (UUID)
- `user_id` (FK - quem reportou)
- `name` (String)
- `age` (Integer)
- `status` (ENUM: 'missing', 'found')
- `last_seen_location` (String)
- `description` (Text)
- `reporter_name` (String)
- `reporter_phone` (String)
- `photo_url` (String)

### C. `shelters` (Abrigos)
- `id` (UUID)
- `user_id` (FK - gestor do abrigo)
- `name` (String)
- `address` (Text)
- `capacity` (Integer)
- `occupied` (Integer - atualizado automaticamente)
- `phone` (String)
- `reference_point` (String)
- `lat`, `lng` (Decimal/Float)
- Atributos booleanos de infraestrutura: `has_water`, `has_food`, `has_bath`, `has_energy`, `accepts_pets`, `has_medical`

### D. `shelter_entries` (Controle de Acesso em Abrigos)
*Essa tabela gerencia o fluxo de entrada e saída nos abrigos.*
- `id` (UUID)
- `shelter_id` (FK para shelters)
- `name` (String - nome do chefe da família ou indivíduo)
- `phone` (String)
- `people_count` (Integer)
- `status` (ENUM: 'request', 'incoming', 'present', 'left')
- `assume_message` (Text - mensagem do gestor ao aceitar o caminho)

### E. `volunteers_profiles` (Perfis de Oferta de Ajuda)
*Pode ser uma tabela unificada com JSON ou tabelas separadas para Transporte, Barco e Voluntário de Solo.*
- `user_id` (FK)
- `offer_type` (ENUM: 'transport', 'boat', 'volunteer')
- `vehicle_type` (String - ex: 'car', 'van', 'motor', 'jet')
- `seats_available` (Integer)
- `region` (String)
- `availability` (ENUM: 'full', 'morning', 'afternoon', 'night')
- `skills` (JSON ou Array - ex: ['sort', 'clean', 'health'])

---

## 3. Endpoints Necessários da API

Implemente os controllers com suporte a validação e paginação onde necessário.

### Help Requests (`/api/v1/requests`)
- `POST /` - Criar novo pedido de ajuda.
- `GET /` - Listar pedidos (com filtros por tipo, status e proximidade/lat-lng).
- `GET /:id` - Detalhes do pedido.
- `PUT /:id/status` - (Voluntários/Embarcações) Atualizar status (ex: aceitar pedido).

### Missing Persons (`/api/v1/missing`)
- `POST /` - Registrar pessoa desaparecida.
- `GET /` - Listar desaparecidos (busca por nome, status).
- `PUT /:id/status` - Marcar como 'found' (encontrado).

### Shelters (`/api/v1/shelters`)
- `POST /` - Cadastrar novo abrigo.
- `GET /` - Listar abrigos próximos (filtros por lotação).
- `GET /:id` - Ver detalhes estruturais do abrigo.

### Shelter Management (`/api/v1/shelters/:id/entries`)
*(Foco na lógica de ocupação)*
- `POST /` - Fazer check-in manual ou solicitar vaga.
- `GET /` - Listar todas as entradas, agrupadas por `status`.
- `PUT /:entry_id` - Mudar status da entrada (ex: de 'request' para 'present'). 
  **Regra de Negócio Crucial**: Se o status mudar para 'present', incrementar `occupied` do abrigo correspondente. Se mudar de 'present' para 'left', decrementar.

### Volunteer & Fleet (`/api/v1/volunteers`)
- `POST /` - Criar perfil de voluntário/motorista/barqueiro (Onboarding).
- `GET /` - Buscar voluntários próximos.
- `GET /tasks` - Listar tarefas atribuídas ao voluntário logado.

---

## 4. Integrações Extras (Opcional, mas desejável)
- Configurar rotina para upload de imagens (para desaparecidos e pedidos de ajuda) integrando com o S3 ou Google Drive (já mencionado no seu README).

---
**Instrução Inicial:** Por favor, comece criando as **Migrations**, depois os **Models** do Sequelize com os relacionamentos corretos. Em seguida, os **Controllers** e **Routes**. Use as melhores práticas de tratamento de erros e segurança que já estão configuradas no repositório.
