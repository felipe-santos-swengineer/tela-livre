# TelaLivre

Aplicação Next.js para compartilhar uma tela ao vivo por um link. O vídeo usa WebRTC ponto a ponto; o Supabase Realtime é usado somente para coordenar a conexão entre transmissor e espectadores.

## Rodar localmente

1. Crie um projeto no [Supabase](https://supabase.com/).
2. Em **Project Settings → API Keys**, copie a Project URL e uma chave publicável (`sb_publishable_...`).
3. Crie `.env.local` a partir de `.env.example` e preencha os dois valores.
4. No painel do Supabase, habilite **Realtime** para o projeto.
5. Execute `npm run dev` e abra `http://localhost:3000`.

O compartilhamento de tela precisa de uma conexão segura (`https://`) ou `localhost`. Antes de transmitir, o host pode escolher resolução, FPS e se deseja incluir o áudio da tela/aba. O perfil padrão é 720p/30 FPS para reduzir travamentos. O app nunca solicita nem envia o microfone. A captura de áudio depende do navegador e da aba/opção escolhida na janela de compartilhamento.

## Limites do MVP

- O vídeo é enviado diretamente do computador transmissor a cada espectador. A captura pode ser configurada até 1080p/60 FPS e o bitrate máximo por espectador varia conforme o perfil (2–4,5 Mbps). Perfis mais altos podem exigir mais CPU e upload; o trabalho de codificação também cresce com a audiência. O app não usa um servidor de mídia (SFU).
- O áudio da tela/aba é opcional e depende de o navegador oferecê-lo e de o transmissor selecioná-lo. O microfone não é solicitado.
- A configuração usa STUN público, sem TURN. Algumas redes, VPNs ou firewalls podem impedir a conexão direta.
- Salas usam identificadores aleatórios e ficam abertas a qualquer pessoa com o link. Não há autenticação, senha, gravação ou controle de acesso.
- O Supabase Realtime coordena as conexões; configure os limites do seu projeto antes de usar com uma audiência real.

Para público maior e conexão mais confiável, o próximo passo é usar um SFU (por exemplo, LiveKit) com emissão segura de tokens no backend. Hospedar a página gratuitamente não fornece, por si só, infraestrutura de vídeo.

## Publicar no GitHub Pages

O workflow em `.github/workflows/deploy-pages.yml` compila a aplicação como site estático e publica cada atualização da branch `master` no GitHub Pages. Após o primeiro push, confirme em **Settings → Pages** que a fonte é **GitHub Actions**.

Como o repositório usa Pages no formato `usuario.github.io/nome-do-repositorio`, o workflow configura o caminho base automaticamente. Os links de transmissão incluem esse caminho.

Configure estas variáveis em **Settings → Secrets and variables → Actions → Variables**:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

São variáveis públicas usadas no navegador, não coloque chaves `secret` ou `service_role` nelas. O app ainda aceita `NEXT_PUBLIC_SUPABASE_ANON_KEY` para projetos com as chaves JWT antigas.

Para desenvolvimento local, configure as mesmas variáveis em `.env.local` e execute `npm run dev`. Para outros hosts que suportem Next.js, remova `output: "export"` e configure o build como aplicação Next.js.
