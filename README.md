# Bybit EU Signal Desk

Een onafhankelijk, statisch signalendashboard voor acht Bybit EU Spot Margin-markten. De app gebruikt uitsluitend publieke marktdata en kan geen account lezen of orders plaatsen.

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
- De 90-daagse backtest rekent met 0,25% takerkosten per zijde plus spread, maar niet met borrowing fees.
- Dit dashboard geeft technische marktinformatie en geen financieel advies.
