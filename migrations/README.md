# Strategy migrations

`0001_strategy_collector.sql` bevat de bestaande PRIME / OPPORTUNITY / SHADOW collector-tabellen.

`0002_high_beta_momentum.sql` voegt uitsluitend additieve HIGH-BETA research-tabellen toe. Deze migratie herschrijft of verwijdert geen bestaande strategy-data en kan veilig vóór de code-deploy worden uitgevoerd.
