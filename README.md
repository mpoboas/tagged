# tagged

Triagem de fotos de álbuns do Facebook por reconhecimento facial. Uma extensão de Chrome recolhe as fotos do álbum aberto, a webapp reconhece as pessoas, deixas escolher o que queres e descarregas um zip (`Nome_0001.jpg`…) com os originais e a data de upload no EXIF.

- **webapp + API** (Python, InsightFace): `backend/`
- **extensão de Chrome** (ponte entre o Facebook e a webapp): `extension/`
- Desenho e decisões: [SPEC.md](SPEC.md)

## Correr com Docker (recomendado)

```bash
mkdir tagged && cd tagged
curl -O https://raw.githubusercontent.com/mpoboas/tagged/main/docker-compose.yml
TAGGED_PASSWORD='uma-palavra-passe' docker compose up -d
```

Abre `http://<servidor>:8768` (utilizador `tagged`). Na primeira vez o contentor descarrega os modelos do InsightFace (~280 MB) para `data/models`; demora um ou dois minutos. O servidor não guarda nenhuma pessoa.

- **Palavra-passe:** define `TAGGED_PASSWORD` sempre que o servidor seja acessível fora do teu computador. Sem ela, qualquer pessoa que chegue à porta usa a ferramenta.
- **HTTPS:** põe-no atrás de um proxy reverso (Caddy, Traefik, nginx) quando o abrires na internet. A extensão que descarregas da própria webapp já vem configurada para o endereço com que a abriste (usa o cabeçalho `X-Forwarded-Proto` para saber se é `https`).
- **Imagem:** `ghcr.io/mpoboas/tagged:latest` (amd64 e arm64), construída pelo GitHub Actions a cada push para `main`. Se o pacote for privado, faz `docker login ghcr.io` no servidor ou torna-o público nas definições do pacote no GitHub. A imagem **não** inclui os modelos (licença só para investigação não comercial).
- **Permissões do volume:** o contentor corre com o utilizador 1000. Se o teu utilizador no servidor for outro, `chown -R 1000 data` ou acrescenta `user: "<uid>:<gid>"` ao compose.

## Instalar a extensão

Na webapp, separador **Extensão**: descarrega o zip, descomprime, abre `chrome://extensions`, liga o Modo de programador e carrega a pasta com *Carregar sem compactar*. Recarrega a webapp: o selo no topo passa a "extensão ligada".

## As pessoas a reconhecer

As pessoas ficam **no teu browser**, não no servidor: carregas uma vez, em **Definições → Carregar pessoas**, e não precisas de repetir (ficam guardadas no IndexedDB desse browser; noutro browser ou computador carregas outra vez). O servidor só devolve as caras e os vetores de cada foto, e é o browser que os compara. Por isso, se mudares as pessoas, as sessões antigas atualizam-se sozinhas.

Aceita:
- `people.npz`: um ficheiro com todas as pessoas (o mais simples);
- um `.zip` da pasta `data/refs`, ou a própria pasta (botão "Escolher pasta refs");
- vários `.npy`, um por pessoa, com o nome da pessoa no nome do ficheiro.

Para gerar o `people.npz` no teu computador:

```bash
cd backend
uv sync
uv run tagged cluster --photos ../data/raw     # agrupa as caras de fotos que já tenhas
uv run tagged label                            # dás nome a cada grupo; "Export" gera data/refs e data/people.npz
uv run tagged people-pack                      # (só se já tens data/refs) gera data/people.npz
```

## Correr sem Docker

```bash
cd backend && uv sync
uv run tagged serve            # http://127.0.0.1:8768
```

## Notas

- Os modelos do InsightFace são **só para investigação não comercial**; o código é MIT. Uso pessoal é ok.
- Os embeddings das caras dos teus amigos são dados biométricos: não os publiques nem os metas na imagem. Também por isso ficam só no browser.
- Automatizar o Facebook vai contra os termos da Meta. A extensão só arranca quando carregas e vai ao ritmo de uma pessoa, mas o risco para a conta existe.
