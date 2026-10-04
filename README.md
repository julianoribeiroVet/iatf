# Calendário IATF — JS Rural

Aplicativo de manejo reprodutivo (D0 · D8/D7 · IATF · DG) por lote e retiro, com alerta de
conflito de manejos, autorização prévia, ressincronização automática, indicadores, PDF e WhatsApp.

- **Instalável** no celular (Android/iPhone) e no computador, como um app comum.
- **Funciona sem internet** no campo: tudo é salvo no aparelho na hora e enviado à nuvem
  quando a conexão volta.
- **Sincroniza** entre celular, computador e equipe (Supabase, gratuito), com login e
  controle de quem pode acessar.
- **Não depende do Claude**: são arquivos seus, hospedados na sua conta.

---

## Estrutura do projeto

```
index.html               Página do app
manifest.webmanifest     Dados de instalação (nome, ícone, cores)
sw.js                    Service worker: cache do app para uso offline
css/app.css              Estilos
js/config.js             ← ÚNICO arquivo que você edita (endereço e chave do Supabase)
js/store.js              Dados: cache no aparelho, fila offline e sincronização
js/app.js                Telas e regras do calendário (protocolos, conflitos, PDF…)
js/pwa.js                Instalação e aviso de nova versão
js/logo.js               Logo usada na tela e no PDF
vendor/                  Bibliotecas (Supabase e jsPDF) — sem depender de CDN
icons/                   Ícones do app
supabase/schema.sql      Banco de dados + regras de segurança
dados-iniciais/          Backup com seus lotes atuais, para importar
```

---

## Passo 1 — Criar o banco de dados (Supabase) · ~10 min

1. Crie uma conta gratuita em **https://supabase.com** e clique em **New project**.
   - Nome: `iatf-jsrural` · Região: **South America (São Paulo)** · anote a senha do banco.
2. No menu lateral, abra **SQL Editor → New query**.
3. Abra o arquivo `supabase/schema.sql`, confira na seção 1 os e-mails da equipe
   (já vem com `juliano.ribeirovet1@gmail.com`), cole tudo no editor e clique em **Run**.
   Deve aparecer *Success*.
4. Crie os usuários: **Authentication → Users → Add user → Create new user**.
   - Informe e-mail e senha e marque **Auto Confirm User**.
   - Repita para cada pessoa da equipe. **Todo e-mail precisa estar também na tabela
     `membros`** (passo 3). Para incluir alguém depois:
     ```sql
     insert into public.membros (email, nome) values ('fulano@email.com', 'Fulano');
     ```
5. (Recomendado) Bloqueie cadastros abertos: **Authentication → Sign In / Providers →
   desligue "Allow new users to sign up"**. Assim só entra quem você criar.
6. Copie as chaves: **Project Settings → API**:
   - **Project URL** (ex.: `https://abcd1234.supabase.co`)
   - **anon public** (uma chave longa que começa com `eyJ…`)
   > Nunca use a chave **service_role** no app.

## Passo 2 — Configurar o app

Abra `js/config.js` e cole os dois valores:

```js
window.IATF_CONFIG = {
  supabaseUrl: 'https://abcd1234.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...'
};
```

> Se deixar em branco, o app funciona **só no aparelho** (sem login e sem sincronizar).

## Passo 3 — Publicar no GitHub Pages · ~10 min

1. Crie uma conta em **https://github.com** (ex.: usuário `jsrural`).
2. **New repository** → nome `iatf` → **Public** → *Create repository*.
3. Clique em **uploading an existing file** e arraste **todo o conteúdo desta pasta**
   (inclusive as pastas `css`, `js`, `vendor`, `icons`… e o arquivo `.nojekyll`).
   Clique em **Commit changes**.
4. **Settings → Pages** → *Source*: **Deploy from a branch** → Branch **main**, pasta
   **/ (root)** → **Save**.
5. Em 1–2 minutos o app estará em: **`https://jsrural.github.io/iatf/`**
6. Volte ao Supabase: **Authentication → URL Configuration** → em **Site URL** coloque esse
   endereço (é para onde vai o link de "Esqueci a senha").

> O repositório público mostra o código, não os dados. Os dados ficam no Supabase,
> protegidos por login e pela lista de membros. A chave `anon` foi feita para ficar
> pública; quem protege os dados são as regras do `schema.sql`.

## Passo 4 — Instalar nos aparelhos

- **Android (Chrome):** abra o endereço → menu **⋮** → **Instalar app** (ou *Adicionar à tela inicial*).
- **iPhone (Safari):** abra o endereço → **Compartilhar** → **Adicionar à Tela de Início**.
- **Computador (Chrome/Edge):** ícone de instalar na barra de endereço → **Instalar**.

## Passo 5 — Carregar seus dados atuais

1. Entre com seu e-mail e senha.
2. Na aba **Calendário**, clique em **📂 Importar Backup** e escolha
   `dados-iniciais/backup-iatf-2026-10-03.json` (seus 8 lotes, parâmetros e lançamentos).
3. Pronto: os dados vão para a nuvem e aparecem em todos os aparelhos.

---

## Uso no dia a dia

| Situação | O que acontece |
|---|---|
| Sem internet no curral | Tudo funciona. O selo no topo mostra **● N pendentes**. |
| Internet voltou | Envio automático; o selo volta a **● Online**. |
| Alguém alterou em outro aparelho | A mudança aparece sozinha, em segundos. |
| **✅ Salvar Alterações** | Força o envio imediato e confirma o resultado. |
| **💾 Salvar Backup** | Baixa (ou compartilha, no celular) um arquivo `.json` com tudo. Faça um por semana. |
| Lote apagado por engano | No Supabase, tabela `registros_historico` guarda a versão anterior de tudo. |

## Atualizar o app (nova versão)

1. Substitua os arquivos no GitHub (*Add file → Upload files*).
2. Aumente a versão em **dois** lugares: `sw.js` (`CACHE_VERSION`) e `js/pwa.js`
   (`APP_VERSION`), por exemplo `2.0.1`.
3. Quem estiver usando verá **"Nova versão disponível — Atualizar"**.

## Bom saber

- **Plano gratuito do Supabase:** o projeto é **pausado após 7 dias sem nenhum acesso**. Os
  dados não se perdem: basta entrar no painel do Supabase e clicar em **Restore project**.
  Com uso semanal normal do app, isso não acontece.
- **Conflitos de edição:** se duas pessoas alterarem o **mesmo lote** ao mesmo tempo,
  vale a última gravação. Edições em lotes diferentes nunca se atrapalham.
- **Sair da conta** num aparelho compartilhado apaga os dados locais daquele aparelho,
  a não ser que existam alterações ainda não enviadas (nesse caso elas ficam guardadas).
- **Protocolos:** os parâmetros controlam só o cronograma de datas. Protocolo hormonal,
  produtos e doses são definidos pelo médico-veterinário responsável.
