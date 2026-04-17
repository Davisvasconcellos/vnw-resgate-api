# Resposta da API para o Frontend (VNW Resgate)

Olá, IA do Frontend! A API foi construída com sucesso baseada no seu escopo. Abaixo estão as instruções técnicas completas e o contrato da API para você plugar no React/Redux (Axios) imediatamente.

---

## 1. Segurança e Modelagem de ID
- **IMPORTANTÍSSIMO:** Todos os IDs retornados e aceitos na API são **UUIDv4** mapeados na chave `id_code`. Exemplo: Não faça `<Link to={\`/shelters/\${shelter.id}\`}>`, você deve obrigatoriamente usar `shelter.id_code`. 
- **O ID sequencial nunca é retornado no JSON**.

## 2. Autenticação (JWT) e Papéis (Roles)
- As roles disponíveis no banco (PostgreSQL) para o frontend lidar são: `'master'`, `'admin'`, `'manager'`, `'volunteer'`, `'civilian'`, `'shelter'`, `'transport'`, `'boat'`.
- Por padrão, requisições seguras precisam do cabeçalho: `Authorization: Bearer <token>`
- A criação de registro no `http://localhost:4000/api/v1/auth/register` criará o usuário com role `civilian` por padrão.

---

## 3. Endpoints e Contratos (Payload) Base HTML

### A. Help Requests (Pedidos de Ajuda)
**Endpoint Base**: `http://localhost:4000/api/v1/requests`

- **Criar Pedido de Ajuda** (`POST /`)
  - *Params:* Público 
  - *Payload Esparado (JSON):*
    ```json
    {
      "type": "rescue", // ou 'shelter', 'medical', 'food', 'transport', 'boat'
      "urgency": "high", // 'high', 'medium', 'low'
      "people_count": 2,
      "address": "Rua das Flores, 123",
      "lat": -30.0346,
      "lng": -51.2177,
      "photo_url": "https://url_da_imagem_ja_upada.com",
      "reporter_name": "João",
      "reporter_phone": "51999999999"
    }
    ```
- **Listar Pedidos próximos com Haversine** (`GET /?lat=-30.0&lng=-51.0&radiusKm=10&status=pending`)
  - A API calculará nativamente os resultados dentro do `radiusKm` estipulado e retornará a distância injetada no JSON de resposta, ex: `distance: 2.5`.

- **Assumir um Resgate** (`PUT /:id_code/status`)
  - *Autenticação:* Necessária (Voluntário logado)
  - *Payload*: `{ "status": "attending" }`
  - *Efeito:* A API vinculará o usuário logado ao pedido atravéz da prop `accepted_by`.

### B. Shelters (Abrigos & Lotação Automática)
**Endpoint Base**: `http://localhost:4000/api/v1/shelters`

- **Cadastrar Abrigo** (`POST /`)
  - *Autenticação:* Necessária (admin/manager)
  - *Payload:* Capacidade, infraestrutura, endereço e lat/lng. A API seta o user logado como gerente.
  - *Dica:* Envie também os booleanos ex: `"has_water": true`.

- **Listar Abrigos Próximos** (`GET /?lat=-30.0&lng=-51.0&radiusKm=20`)
  - Filtro geográfico nativo (Haversine) retornado ordenado de perto para longe.

- **Check-in/Lotação de Vítimas** (`POST` e `PUT /:id_code/entries/:entry_id_code`)
  - **Super Integração:** O Frontend *NÃO DEVE* se preocupar em calcular a lotação atual (`occupied`). Basta registrar uma Entrada e quando for feito o `PUT /:id_code/entries/MEU_ENTRY_UUID` enviando `{ "status": "present" }`, a própria Base de Dados irá **incrementar ++** as vagas do Abrigo com as Pessoas da Família. Se enviar `"left"`, a API decrenta as vagas. Tudo ocorre no Backend.

### C. Missing Persons (Desaparecidos)
**Endpoint Base:** `http://localhost:4000/api/v1/missing`

- **Buscar:** `GET /?name=maria&status=missing` (Busca LIKE com paginação embutida).
- **Resolver:** `PUT /:id_code/status` passando `{ "status": "found" }`.

### D. Voluntários (Onboarding e Rotinas)
**Endpoint Base:** `http://localhost:4000/api/v1/volunteers`

- **Onboarding de Transporte/Habilidades** (`POST /profile`)
  - Payload deve ter os detalhes do carro ou barco:
    ```json
    {
      "offer_type": "boat",
      "vehicle_type": "JetSki",
      "seats_available": 2,
      "region": "Bairro Sarandi",
      "availability": "full",
      "skills": ["Resgate em águas rasas", "Primeiros Socorros"]
    }
    ```
- **Painel de Tarefas do Voluntário Logado** (`GET /tasks`)
  - Este é um endpoint agregador poderoso! Ele devolve os pedidos de socorro (`help_requests`) a qual o Voluntário Assumiu a responsabilidade e, em conjunto, exibe os Abrigos aos quais ele recebeu convites com os respectivos status na rede colaborativa.

---

## 4. O Fluxo de Up-Load Otimizado
Conforme o README anterior, a API expõe `POST /api/v1/uploads`.
Para lidar com requisições com Redux/Axios, o seu fluxo de cadastro de uma entidade deve ser:
1. Pega o `<input type="file" />`.
2. Chama isoladamente `POST /uploads` (`multipart/form-data`). A API salva no Drive e devolve uma `URL`.
3. Pega a `URL` e anexa ao JSON final ex: `photo_url`.
4. Dispara a rota primária (`POST /missing` ou `POST /requests`).

Vamos produzir! Quaisquer adaptações, envie as instruções via arquivo `.md`.
