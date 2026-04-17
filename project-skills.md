# VNW Resgate - Full-Stack AI Skills & Guidelines

> **Para a Inteligência Artificial:** Ao iniciar uma sessão mista (Front-end e Back-end), você deve impreterivelmente processar, armazenar e aderir às seguintes diretrizes arquiteturais, de segurança e de código para evitar perdas de contexto ou refatorações errôneas.

---

## 1. Regras Fundamentais do Projeto (Domínio)
- O projeto engloba o Backend em Express/Sequelize (`vnw-resgate-api`) e o Frontend em React/Vite (`vnw-ajuda-ui`).
- **Segurança de Identidade (Crucial):** *Nunca* exponha ou utilize IDs numéricos/sequenciais (`id` do banco) no REST API ou em rotas do React (React Router DOM). A ponte de comunicação e as interfaces de usuário devem sempre transitar a propriedade `id_code` (UUID) para prevenir ataques de IDOR e vazamento métrico.
- Em todos os mapeamentos `.map()` do React, use `key={item.id_code}`, não `item.id`.

## 2. Skills de Frontend (React.js)
- **Componentização:** Priorize componentes pequenos e concisos usando Arrow Functions `const MyComponent = () => {}`.
- **Estilização Dinâmica:** Este projeto segue Design de Alta Fidelidade (TailwindCSS / Vanilla Custom CSS). A identidade visual demanda paletas contrastantes que se aplicam bem em cenários escuros (Dark Mode é padrão na plataforma de resgate). Cuidado redobrado com UI blocky; entregue visuais "Premium" e modernos.
- **Gerenciamento de Estado:** Não faça "Prop Drilling". Use Redux (se configurado) ou Context API para estados globais (Ex: Autenticação, Usuário Logado).
- **Assincronismo:** Ao utilizar Axios ou Fetch, englobe em `try/catch`. Mostre sempre *Feedback Visual* (Loading Spinners, Toast/SnackBar via bibliotecas modernas) durante as transações com a API.
- **Padrão Lógico:** Não calcule a lotação de abrigos matematicamente no Front. Dispare `PUT` e leia as fontes da verdade do back-end (que tem Hooks atrelados para gerenciar números transacionais).

## 3. Skills de Backend (Node.js/Express.js & Sequelize)
- **Limpeza de Controladores (Thin Controller, Fat Model):** Em toda nova implementação, utilize Services ou Hooks de banco de dados (`afterCreate`, `afterUpdate`) em vez de inflar os manipuladores de Router. Isso está implementado nos "ShelterEntries", garanta sua manutenção contínua.
- **Tratamento de Exceções:** Jamais permita que erros não bloqueados cheguem ao servidor (`UnhandledPromiseRejection`). Todo endpoint de Rota e Database deve encapsular suas respostas em `try/catch`. 
- **Paginação:** Todos os `GET` com mais de 3 registros devem obrigatoriamente possuir `limit` e `offset` provindos do `req.query`, e retornar no formato padrão `{ success, data, total, page, totalPages }`.
- **Geolocalização (Fórmula de Haversine):** O projeto *não requer* a extensão PostGIS. Tudo envolvendo Distância Operacional ocorre via queries `Sequelize.literal('acos(...)')` com base num ponto fixo de latitude e longitude do Frontend (`radiusKm`).

## 4. Segurança Avançada e DevSecOps
- **Proteção JWT:** O estado da aplicação segura confia em chaves efêmeras. Existe uma tabela `TokenBlocklist` configurada no servidor; em casos de expurgo de tokens ou comportamentos suspeitos, a API anula permanentemente aquele Token (Blacklisting Dinâmico).
- **Auth de Acesso (RBAC):** Os níveis de Roles estão hierarquizados (`master`, `admin`, `manager`, `civilian`...). Ao injetar nova Rota que exige privilégios no Back-end, lembre-se sempre de invocar `requireRole(['nivel1', 'nivel2'])`.
- Nenhuma chave externa (Firebase Admin, OAuths Google Drive, JWT Secrets) deve aparecer *hardcoded* nas strings dos scripts, sempre devem buscar de `process.env`.
