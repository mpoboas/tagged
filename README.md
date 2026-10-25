# tagged

Triagem de fotos de álbuns do Facebook por reconhecimento facial. Uma extensão de Chrome percorre o álbum aberto e recolhe as fotos, a webapp reconhece as pessoas, revês e escolhes o que queres, e descarregas um zip (`Nome_0001.jpg`…) com os originais e a data de upload no EXIF, ou envias tudo diretamente para um álbum novo no Google Photos.

- **webapp + API** (Python, InsightFace): `backend/` (a página está em `backend/tagged/web/`)
- **extensão de Chrome** (ponte entre o Facebook e a webapp): `extension/`
- Desenho e decisões: [SPEC.md](SPEC.md)

## Correr com Docker (recomendado)

```bash
mkdir tagged && cd tagged
curl -O https://raw.githubusercontent.com/mpoboas/tagged/main/docker-compose.yml
TAGGED_PASSWORD='uma-palavra-passe' docker compose up -d
```

Abre `http://<servidor>:8768` (utilizador `tagged`). A página abre logo. Na primeira vez o contentor descarrega os modelos do InsightFace (~280 MB) para `data/models`, e a webapp mostra "A preparar o reconhecimento facial…" até estarem prontos. O servidor não guarda nenhuma pessoa.

- **Palavra-passe:** define `TAGGED_PASSWORD` sempre que o servidor seja acessível fora do teu computador. Sem ela, qualquer pessoa que chegue à porta usa a ferramenta.
- **Nomes de anfitrião:** sem palavra-passe, o servidor só aceita pedidos feitos por IP ou `localhost` (proteção contra *DNS rebinding*). Se o abres por um nome (`nas.local`, `tagged.exemplo.com`), põe-no em `TAGGED_ALLOWED_HOSTS` (separados por vírgulas) ou define uma palavra-passe.
- **HTTPS:** põe-no atrás de um proxy reverso (Caddy, Traefik, nginx) quando o abrires na internet. A extensão que descarregas da própria webapp já vem configurada para o endereço com que a abriste.
- **Imagem:** `ghcr.io/mpoboas/tagged:latest` (amd64 e arm64, cada uma construída nativamente pelo GitHub Actions a cada push para `main`, depois de passarem os testes). Se o pacote for privado, faz `docker login ghcr.io` no servidor ou torna-o público nas definições do pacote no GitHub. A imagem **não** inclui os modelos (licença só para investigação não comercial).
- **Permissões do volume:** o contentor corre com o utilizador 1000. Se o teu utilizador no servidor for outro, `chown -R 1000 data` ou acrescenta `user: "<uid>:<gid>"` ao compose.

## Instalar a extensão

Na webapp, separador **Extensão**: descarrega o zip, descomprime, abre `chrome://extensions`, liga o Modo de programador e carrega a pasta com *Carregar sem compactar*. Recarrega a webapp: o selo no topo passa a "extensão ligada". Quando houver uma versão nova, o selo avisa.

## Usar

1. Abre o álbum no Facebook noutro separador e carrega em **Obter fotos do Facebook**. A extensão traz o separador do Facebook para a frente, percorre o álbum sozinha (ao ritmo de uma pessoa) e volta à webapp no fim. **Parar** interrompe.
2. Revê as fotos em **certeza** / **rever** / **sem match**. Atalhos (tecla `?`): setas para mudar de foto, `Enter` para ampliar, `espaço` para incluir ou tirar, `P` / `X` para incluir ou deixar de fora e passar à seguinte.
3. Quando uma cara não é reconhecida, amplia a foto, clica na cara e diz quem é: passa a ser uma referência dessa pessoa e as fotos são reavaliadas. O separador **caras por nomear** junta as caras repetidas que ninguém reconheceu, para dares nome a uma pessoa nova de uma vez.
4. **Descarregar zip** (ou **Enviar para o Google Photos**) vai buscar os originais ao álbum aberto no Facebook.

## As pessoas a reconhecer

As pessoas ficam **no teu browser**, não no servidor: carregas uma vez, em **Definições → Carregar pessoas**, e não precisas de repetir (ficam no IndexedDB desse browser; noutro browser ou computador carregas outra vez, ou usas **exportar people.npz**, que inclui as caras que nomeaste na webapp). O servidor só devolve as caras e os vetores de cada foto, e é o browser que os compara. Por isso, se mudares as pessoas, as sessões antigas atualizam-se sozinhas.

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
uv run tagged eval                             # precisão/recall por limiar, com as fotos reduzidas ao tamanho das miniaturas do Facebook
```

## Enviar para o Google Photos (opcional)

1. Na [Google Cloud Console](https://console.cloud.google.com/): cria um projeto, ativa a **Photos Library API** e configura o ecrã de consentimento OAuth (tipo *External*, em modo de teste, com o teu e-mail como utilizador de teste).
2. Cria uma credencial **OAuth client ID** do tipo *Web application* e acrescenta o endereço da webapp (ex.: `http://localhost:8768` ou `https://tagged.exemplo.com`) em *Authorized JavaScript origins*.
3. Arranca o servidor com `TAGGED_GOOGLE_CLIENT_ID=<o client ID>`. Aparece o botão **Enviar para o Google Photos**: cria um álbum com o nome da sessão e envia as fotos (com a data no EXIF). Só usa o âmbito `photoslibrary.appendonly`, que não dá acesso às tuas fotos existentes.

## Correr no teu computador (sem Docker)

Duplo clique no iniciador do teu sistema. Instala as dependências na primeira vez, arranca o servidor e abre a webapp no browser. **O servidor só corre enquanto a janela estiver aberta:** no macOS prime qualquer tecla para o parar (fechar a janela também o pára); no Windows prime Ctrl+C ou feche a janela. Se já estiver a correr, o iniciador só abre o browser (no macOS oferece-se a parar esse servidor com a tecla P).

| Sistema | Iniciar | Arranque automático ao iniciar sessão | Remover |
|---|---|---|---|
| macOS | `start.command` | `scripts/autostart-install.command` | `scripts/autostart-remove.command` |
| Windows | `start.bat` | `scripts\autostart-install.bat` | `scripts\autostart-remove.bat` |

- **macOS** é o modo mais rápido: usa o chip da Apple (CoreML), cerca de 0,07 s por foto, contra 1 a 5 s só com CPU (Docker, Windows, servidores). Precisa das ferramentas de linha de comandos da Apple (`xcode-select --install`) e do `uv`, que o script oferece instalar. Se descarregares o projeto num zip, o macOS bloqueia o duplo clique: clica com o botão direito e escolhe *Abrir*, ou corre `chmod +x start.command scripts/*.command`.
- **Windows** usa só CPU. O InsightFace compila uma extensão e precisa do *Microsoft C++ Build Tools*; se a instalação falhar, o `start.bat` tenta o Docker Desktop (`docker compose up -d`). Não foi testado em Windows.
- **Arranque automático:** no macOS é um LaunchAgent (`top.povoas.tagged`) que arranca o servidor quando inicias sessão e o relança se falhar, sem abrir o browser; o registo fica em `~/Library/Logs/tagged.log`. No Windows é um ficheiro na pasta *Arranque* que corre o servidor escondido; o registo fica em `%LOCALAPPDATA%\tagged\tagged.log`. Não precisam de administrador.
- **Porta:** `TAGGED_PORT=9000` (por defeito 8768). A extensão que vem com a webapp local funciona em qualquer porta.

À mão, em qualquer sistema:

```bash
cd backend && uv sync
uv run tagged serve            # http://127.0.0.1:8768
```

## Notas

- Os modelos do InsightFace são **só para investigação não comercial**; o código é MIT. Uso pessoal é ok.
- Os embeddings das caras dos teus amigos são dados biométricos: não os publiques nem os metas na imagem. Também por isso ficam só no browser, e a página só carrega scripts do próprio servidor (mais o da Google, se ativares o envio para o Google Photos).
- Automatizar o Facebook vai contra os termos da Meta. A extensão só arranca quando carregas e vai ao ritmo de uma pessoa, mas o risco para a conta existe.
