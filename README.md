# Crypto Strategy Decision Desk

Een onafhankelijk Kraken Pro Futures-dashboard met drie strikt gescheiden lagen:

- **PRIME 85+** — de bestaande, ongewijzigde hoofdstrategie met risicoklasse `1.0R`.
- **OPPORTUNITY 82–84** — experimentele vervolgkansen die alle aanvullende kwaliteits-, bevestigings-, liquiditeits- en chasefilters halen; risicoklasse `0.25R`.
- **SHADOW 78–84** — uitsluitend onderzoeksregistratie, zonder orderkaart, alert of risicobudget.

De browser gebruikt alleen publieke Kraken-marktdata. Orders blijven volledig handmatig. De server-side collector kan goedgekeurde setups en hun objectieve 24-uursuitkomsten in Neon Postgres opslaan, maar krijgt nooit toegang tot een Kraken-account, saldo of API-sleutel.

## Architectuur

- `js/signals.js` en `passes85TradeGate` blijven de bron voor PRIME.
- `js/strategy-engine.js` classificeert daarna OPPORTUNITY en SHADOW zonder de PRIME-drempel te versoepelen.
- `js/relative-strength.js` bevat de Relative Strength Continuation-regels ten opzichte van BTC.
- `server/kraken-strategy-collector.js` scant periodiek publieke Kraken-data, schrijft alleen server-side naar Neon en levert alertpayloads voor PRIME/OPPORTUNITY.
- `js/outcome-evaluator.js` evalueert na 24 uur stop, T1, T2, MFE, MAE en R-resultaat zonder vooruitkijken. Als stop en target in dezelfde candle vallen, blijft de uitkomst bewust `AMBIGUOUS`.
- `migrations/0001_prime_opportunity_shadow_v1.sql` maakt de append-only setup-, transitie-, outcome- en compacte uur-snapshottabellen.

Er worden geen ticks of volledige candlehistorieën in Neon bewaard. Alleen beslissingssnapshots, lifecycle-overgangen, uitkomsten en compacte uurwaarden voor onder meer open interest worden opgeslagen.

## Lokaal starten

```bash
npm install
npm run serve
```

Open daarna `http://localhost:4173`. Zonder `DATABASE_URL` blijft het dashboard werken met publieke Kraken-data; het validatiepaneel toont dan veilig dat Neon niet is geconfigureerd.

Controleer code en tests met:

```bash
npm run check
npm test
```

## Feature flags

De huidige defaults staan bewust aan:

```text
OPPORTUNITY_SIGNALS_ENABLED=true
SHADOW_TRACKING_ENABLED=true
```

Zet een flag server-side op `false` om die laag uit te schakelen. Browsercode bevat geen databasewachtwoord of collector-token.

## Neon en collector activeren

Voer dit pas uit na expliciete goedkeuring en bij voorkeur eerst op een aparte Neon-testbranch:

1. Pas `migrations/0001_prime_opportunity_shadow_v1.sql` toe.
2. Stel server-side `DATABASE_URL` en een sterk `CRON_SECRET` in.
3. Stel desgewenst `STRATEGY_SCAN_LIMIT`, `OPPORTUNITY_SIGNALS_ENABLED` en `SHADOW_TRACKING_ENABLED` in.
4. Deploy daarna pas naar Vercel.
5. Controleer `/api/strategy/analytics` en start één beveiligde collector-run voordat de cron actief wordt gebruikt.

Vercel roept `/api/strategy/collect` iedere 15 minuten aan. Zonder geldige bearer-authenticatie weigert deze route de run. `/api/strategy/analytics` is alleen-lezen en geeft zonder databaseconfiguratie een veilige lege status terug.

## Uitkomstmeting

De evaluator gebruikt candles vanaf het moment ná de geregistreerde setup tot maximaal 24 uur later:

- LONG en SHORT worden chronologisch en afzonderlijk verwerkt.
- MFE en MAE worden ten opzichte van entry en initiële stopafstand gemeten.
- Stop en targets krijgen het eerste aantoonbare raaktijdstip.
- Zowel een onbewerkte uitkomst als een 50/50-uitkomst wordt bewaard.
- Na T1 blijft voor de reproduceerbaarheid de oorspronkelijke stop gelden.
- Een candle die zowel stop als target raakt is ambigu; er wordt geen kunstmatige winst of verlies toegekend.

Het compacte validatiepaneel groepeert resultaten in `85+ PRIME`, `82–84 OPPORTUNITY`, `82–84 SHADOW`, `80–81 SHADOW` en `78–79 SHADOW`. De extra 82–84 SHADOW-rij voorkomt dat afgewezen kandidaten statistisch als Opportunity worden behandeld. Bij minder dan twintig evalueerbare observaties verschijnt een waarschuwing.

## Veiligheidsgrenzen

- Geen automatische orders, private Kraken-endpoints of accountkoppeling.
- PRIME en OPPORTUNITY mogen alleen een handmatige orderkaart krijgen; SHADOW nooit.
- Een OPPORTUNITY gebruikt exact 25% van het normale PRIME-risicobudget.
- Niet-gekwalificeerde LONG/SHORT-uitkomsten worden teruggebracht naar `WATCH`.
- Alertpayloads worden voorbereid, maar er is geen extern berichtkanaal geconfigureerd.
- De app is technische onderzoekssoftware en geen financieel advies.

## Productiestatus

Deze wijziging voert zelf geen Neon-migratie uit en deployt of pusht niets naar productie. De bestaande Vercel-site blijft onaangeraakt totdat de migratie, omgevingsvariabelen en deployment afzonderlijk worden goedgekeurd.
