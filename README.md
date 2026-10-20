# Folhas da prova

Anexe as fotos de uma prova e receba as questões respondidas em folhas com letra
manuscrita (PNG), prontas para baixar ou copiar.

## Publicar (GitHub + Render)

1. Crie um repositório no GitHub e envie todos os arquivos desta pasta.
2. No Render: New > Blueprint (ou Web Service) e escolha o repositório.
   - Com o `render.yaml` ele já preenche tudo. Build: `npm ci`, Start: `npm start`.
3. Em Environment, cole o valor de `ANTHROPIC_API_KEY`. É o único campo que fica vazio de propósito.
4. Deploy. O endereço público aparece no painel do Render.

A chave só existe no painel do Render. Ela não está em nenhum arquivo do repositório.
O site não tem senha: qualquer pessoa com o link consegue usar (e gastar a cota da API).
Não divulgue o endereço.

## Rodar no computador

1. `npm install`
2. Copie `.env.example` para `.env` e preencha `ANTHROPIC_API_KEY`.
3. `npm start` e abra http://localhost:3000

Teste sem gastar a API: `MOCK=1 npm start`.

## Se der erro

- Erro de modelo: troque `MODEL` por um nome aceito pelo seu provedor.
- Erro 401 ou 403: confira a chave e a base URL.
- Render gratuito dorme sem uso; o primeiro acesso depois de um tempo demora alguns segundos.

## Como funciona

- `server.js` recebe as fotos, chama a API e devolve um JSON com as respostas.
- `public/app.js` desenha as folhas em canvas com a fonte Caveat (em `public/fonts`).
- "Conferir e editar respostas" permite corrigir qualquer resposta; as folhas se atualizam na hora.
- Questões em que a IA ficou em dúvida aparecem com a etiqueta "conferir".
