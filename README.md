# Kraken Pro Futures Signal Desk

Een onafhankelijk, dependency-vrij signalendashboard voor lineaire Kraken Pro-crypto-perpetuals. De app gebruikt alleen publieke Kraken-data en kan geen account lezen of orders plaatsen.

De scanner rangschikt de top 30 op 24-uursvolume, toont alle toegestane EEA-crypto-perpetuals in de marktzoeker en analyseert gesloten candles op 1 uur, 4 uur en 1 dag. Bij een actueel LONG- of SHORT-signaal kan de handmatige orderassistent een futuresorder voorbereiden. De gebruiker controleert en verstuurt iedere order zelf in Kraken Pro.

## Lokaal starten

```bash
npm run serve
```

Open daarna `http://localhost:4173`. De lokale Node-server proxy't uitsluitend de toegestane publieke Kraken-routes.

## Tests

```bash
npm test
```

## Productie

- Vercel: <https://crypto-dashboard-mu-two.vercel.app>
- GitHub Pages verwijst vanuit de app door naar Vercel.
- De beperkte reverse proxy staat in `vercel.json`.

## Databron en beperkingen

- REST: publieke Kraken Futures-instrumenten, tickers, candles, funding en spreads.
- WebSocket: `wss://futures.kraken.com/ws/v1` voor live tickerdata.
- Signalen gebruiken alleen gesloten candles en futuresfilters voor spread, funding, premium en marktstatus.
- De orderassistent gebruikt standaard €20 budget, 10% risico, isolated margin en maximaal 10x leverage.
- EUR wordt met de publieke `PF_EURUSD`-index naar USD omgerekend. Zonder actuele FX-data blijft de orderkaart geblokkeerd.
- Het lokale Kraken-versie-2-journal ondersteunt JSON-export/import en bewaart nooit login-, saldo- of API-gegevens.
- Liquidatieprijs, accountgeschiktheid, collateral en werkelijke fills moeten altijd in Kraken Pro worden gecontroleerd.
- Dit dashboard geeft technische marktinformatie en geen financieel advies.
