# Bybit EU Signal Desk

Een onafhankelijk, statisch signalendashboard voor acht Bybit EU Spot Margin-markten. De app gebruikt uitsluitend publieke marktdata en kan geen account lezen of orders plaatsen.

Bij een actueel LONG- of SHORT-signaal kan de handmatige orderassistent een limietorder voorbereiden. De gebruiker kopieert de waarden en controleert en verstuurt de order altijd zelf in Bybit EU.

## Lokaal starten

```bash
npm run serve
```

Open daarna `http://localhost:4173`.

## Tests

```bash
npm test
```

## Databron en beperkingen

- REST: `https://api.bybit.eu`
- WebSocket: `wss://stream.bybit.eu/v5/public/spot`
- Signalen gebruiken alleen gesloten candles op 1 uur, bevestigd door 4 uur en 1 dag.
- Publieke marktstatus bevestigt niet dat een asset voor een specifiek account leenbaar is.
- De orderassistent gebruikt standaard 20 USDC budget en 10% risico per trade. Deze lokale rekeninstellingen zijn geen werkelijk saldo.
- Positiegrootte wordt begrensd door risicobudget, budget, leverageadvies en de publieke Bybit-orderstappen en -minima.
- Een lokaal tradejournal ondersteunt handmatige statussen en JSON-export/import. Het bewaart nooit login-, saldo- of API-gegevens.
- Borrowing fees, slippage en liquidatiekosten worden niet vooraf berekend en moeten handmatig in Bybit EU worden gecontroleerd.
- De 90-daagse backtest rekent met 0,25% takerkosten per zijde plus spread, maar niet met borrowing fees.
- Dit dashboard geeft technische marktinformatie en geen financieel advies.
