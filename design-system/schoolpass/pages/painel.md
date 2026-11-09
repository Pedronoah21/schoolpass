# Painel administrativo — ajustes sobre o MASTER

Este painel é uma ferramenta interna, não uma landing page. O padrão "Real-Time / Operations Landing"
do MASTER não se aplica à estrutura. Valem o estilo, as cores, a tipografia e os tokens.

## Decisões
- **Tema escuro** = paleta do MASTER (Smart Home/IoT Dashboard: escuro tech + verde de status).
- **Tema claro** = paleta "B2B Service" da base (fundo #F8FAFC, cartão #FFFFFF, borda #E2E8F0,
  texto #020617, texto suave #475569), com o verde de status escurecido para #15803D (contraste 4.5:1 no claro).
- Tema segue o sistema e pode ser trocado manualmente (botão no topo).
- **Fontes**: Fira Sans no texto, Fira Code em horários, números, IDs de cartão e IPs (tabular).
- **Densidade 8/10**: escala de espaçamento 2/4/8/12/16/24/32px.
- **Navegação**: barra lateral no desktop; barra inferior no celular com no máximo 5 itens
  (Ao vivo, Pessoas, Turmas, Catracas, Relatórios). O calendário fica dentro de Turmas.
- **Ao vivo**: indicador de conexão com horário da última atualização e estado "desatualizado"
  depois de 60 s sem sinal do servidor. Contadores com `role="status"`.
- **Ícones**: SVG em linha no estilo Lucide (traço 2px). A busca de ícones da base não retornou
  resultado; esta escolha segue o checklist do MASTER ("SVG: Heroicons/Lucide, sem emoji").
- Tabelas viram cartões abaixo de 720px. Alvos de toque de no mínimo 44px no celular.
- Foco visível em todos os controles; animações de 150–250ms e desligadas com `prefers-reduced-motion`.
