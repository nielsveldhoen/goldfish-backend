# Goldfish — Schaal- en kostenplan (Oracle Cloud)

*Opgesteld: 2026-07-07. Prijzen zijn OCI PAYG-lijstprijzen (USD) van juli 2026.*

## Uitgangssituatie

- **Server:** Oracle Always Free micro-VM (VM.Standard.E2.1.Micro): 1 GB RAM, 2 vCPU-threads (zwaar geknepen/burstable), geen swap, 45 GB disk. IP `141.148.226.78` (reserved), domein `goldfishstudy.app` via nginx + Let's Encrypt.
- **Stack op één machine:** Node-backend (pm2, één proces, ~90 MB), PostgreSQL 12 (lokaal), nginx (reverse proxy + statische Flutter-web).
- **Gemeten (2026-07-07):** load 0.00, ~410 MB RAM vrij, DB 9,5 MB (2 users, 755 cards).
- **Capaciteit huidige setup:** ± 300–500 gelijktijdig actieve gebruikers ≈ 1.000–2.000 dagelijks actieve gebruikers. RAM is de bottleneck; zonder swap eindigt overbelasting in een OOM-kill.

## Kostenreferentie (Ampere A1.Flex, PAYG)

$0,01 per OCPU-uur + $0,0015 per GB-uur. Gratis A1-tegoed op PAYG: **1.500 OCPU-uren + 9.000 GB-uren per maand** (sinds 15-06-2026 gehalveerd; komt neer op 2 OCPU / 12 GB continu gratis).

| Setup (24/7) | Bruto/mnd | Na gratis tegoed | Indicatieve capaciteit |
|---|---|---|---|
| Huidige micro (1 GB) | $0 | $0 | ~300–500 gelijktijdig |
| A1: 2 OCPU / 12 GB | ~$28 | **~$0** | ~2.000–5.000 gelijktijdig |
| A1: 4 OCPU / 24 GB | ~$56 | ~$28 | ~5.000–10.000 gelijktijdig |
| A1: 8 OCPU / 48 GB | ~$112 | ~$84 | meer; DB afsplitsen wordt dan zinniger |

Capaciteitsgetallen zijn ordegroottes voor dít verkeersprofiel (korte, lichte API-calls + idle WebSockets), geen benchmarks.

## Fase 0 — Nu, gratis, ~1 uur werk

1. **Account upgraden naar Pay As You Go** (Console → Billing → Upgrade). Kost niets zolang je binnen het gratis tegoed blijft; voordelen: geen idle-reclaim van A1-instances, en beschermd tegen verdere free-tier-verlagingen.
2. **Budget-alert instellen** (Billing → Budgets), bijv. $10/mnd met e-mailalert — vangnet tegen verrassingen na de PAYG-upgrade.
3. **Swapfile van 2 GB** op de huidige VM aanmaken, zodat een geheugenpiek vertraging wordt in plaats van een crash.
4. **pm2 `max_memory_restart`** zetten (bijv. 350 MB) voor het proces `goldfish-backend`.

## Fase 1 — Migratie naar A1.Flex 2 OCPU / 12 GB (gratis, ~halve dag)

Doel: 12× het huidige RAM, binnen het gratis tegoed. Let op: A1 is **ARM (aarch64)** — Node en Postgres zijn er gewoon voor beschikbaar, maar native npm-modules worden opnieuw gecompileerd bij `npm install`.

1. Nieuwe VM.Standard.A1.Flex (2 OCPU / 12 GB, Ubuntu 22.04/24.04) aanmaken in dezelfde VCN/subnet.
2. Provisioning zoals de huidige box: Node + pm2, PostgreSQL, nginx (server-blocks `goldfish` en `api-goldfishstudy` overnemen), certbot, iptables (22/80/443, `-I` vóór de REJECT-regel, `netfilter-persistent save`) + Oracle Security List.
3. Data over: `pg_dump` op oud → `pg_restore`/`psql` op nieuw; `src/.env` kopiëren; repo clonen naar `/home/ubuntu/goldfish/goldfish-backend`; frontend-bestanden naar `/home/ubuntu/goldfish/frontend`.
4. **Reserved IP `goldfish-static` (141.148.226.78) omhangen** van de oude naar de nieuwe instance (Networking → Reserved IPs). Dan hoeven DNS/Cloudflare en de Flutter-app niets te weten van de wissel.
5. Health-check (`curl https://api.goldfishstudy.app/version`, WS-test), daarna oude micro-VM een week laten staan als fallback en dan opruimen.
6. Vóór de deploy-stappen: memory-bestand `project_remote_deploy` volledig lezen en na afloop bijwerken (nieuw OS, paden, shape).

## Fase 2 — Verticaal bijschalen (op aanvraag, minuten werk)

Trigger-signalen (alarmen instellen in OCI Monitoring, gratis op dit niveau):
- `free -m` available structureel < 20% van totaal;
- CPU-utilization > 70% tijdens piekuren (avond);
- p95-responstijden merkbaar omhoog in piek.

Actie: instance resizen naar 4 OCPU / 24 GB (~$28/mnd) — reboot van ~1 minuut. Daarna eventueel pm2 in **cluster-mode** (meerdere workers) zetten; dat kan pas goed nadat de WS-broadcasts multi-proces-veilig zijn (zie Fase 3, Redis pub/sub geldt ook voor cluster-mode op één machine).

## Fase 3 — Horizontaal + autoscaling (pas bij tienduizenden actieve users)

Echte OCI-autoscaling = instance pool + autoscaling-config (op CPU/RAM-metrics) achter een load balancer (10 Mbps flexible LB is Always Free). Vereist eerst een stateless backend:

1. **PostgreSQL afsplitsen** naar een eigen VM (of managed DB) — meerdere app-instances delen één DB.
2. **WebSocket-broadcasts via Redis pub/sub**: broadcasts in `src/ws.js` zijn nu in-process; met meerdere instances missen clients op instance B events die op instance A binnenkomen. Publiceer events naar Redis, elke instance broadcast naar zijn eigen sockets.
3. **Sticky sessions / WS-routing** op de load balancer; TLS-terminatie verhuist naar de LB of blijft per-instance via nginx.
4. Instance-image of cloud-init maken zodat de pool automatisch identieke instances start (code via `git pull` van GitHub, `.env` via OCI Vault of instance-metadata).
5. Autoscaling-config: bijv. min 1 / max 3 instances, scale-out bij CPU > 70% (5 min), scale-in bij < 30%.

Kosten dan: DB-VM (~$28/mnd voor 2 OCPU/12 GB) + 1–3 app-instances + Redis (klein, kan op de DB-VM). Totaal grofweg $30–100/mnd afhankelijk van belasting.

## Samenvatting

| Fase | Wanneer | Kosten | Effect |
|---|---|---|---|
| 0. PAYG + swap + budgetalert | nu | $0 | crash-vangnet, geen reclaim-risico |
| 1. A1 2/12 migratie | nu of binnenkort | $0 | ~10× capaciteit |
| 2. Resize 4/24 → 8/48 | bij alarmsignalen | $28 → $84/mnd | nog eens 2–4× per stap |
| 3. Autoscaling + DB-split | tienduizenden users | $30–100+/mnd | horizontaal, geen plafond |

Kernprincipe: **capaciteit kopen op het moment dat metrics erom vragen**, niet vooraf. Tot en met fase 1 blijft alles $0.
