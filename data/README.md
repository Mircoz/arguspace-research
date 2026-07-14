`ucs-satellite-database.csv` — snapshot del **1 maggio 2023**, fornito da
Mirco, già incluso nel repo. Contiene 7.560 satelliti attivi, 68 colonne.

Il database UCS si aggiorna circa ogni trimestre — questo snapshot ha oltre
2 anni. Vale la pena riscaricare una versione più recente da
https://www.ucsusa.org/resources/satellite-database prima di un run
definitivo, specialmente per catturare lanci/decommissioni recenti. Lo
snapshot attuale resta comunque utile per iniziare senza bloccarsi sul
passaggio manuale di download.

Validato contro il parser reale: 890 oggetti LEO alto valore (Users
contiene "Military" o "Government") su questo snapshot — Cina 279, USA 256,
Russia 73, ESA 28, India 27, e altri.
